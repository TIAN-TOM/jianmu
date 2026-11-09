// 笔记：保存（同一视频同一秒去重、后台润色）、编辑、删除、列出。先存字幕原文，保存立即完成；
// AI 配置可用时回复之后才在后台润色，润色不等待，失败留原文，用户在这期间改过正文就不覆盖。
// 去重之后才问润色名额：播放页来的笔记每分钟只润色几条，超出的只存原文。
// YouTube 的字幕要等页面读，记笔记不替页面去读：本机还没有字幕时只存时间点，不润色。
import { parseLooseJson } from "../../core/ai/parse.ts";
import { NOTE_QUOTE } from "../../core/ai/schemas.ts";
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import { fail, ok, type Failure, type Result } from "../../core/errors.ts";
import type { Derived, NoteRecord } from "../../core/notes/records.ts";
import type { FrozenGen } from "../../core/tasks.ts";
import { noteContextAt, type NoteContext } from "../../core/transcript/note-context.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import { keepAliveBudget, type KeepAlive } from "../../platform/keepalive.ts";
import { isQuotaError } from "../../platform/storage.ts";
import type { Broadcast } from "../../shared/messages.ts";
import type { EmptyRequest } from "../../shared/messages/core.ts";
import type { NoteItemView, NoteListView, NoteSaveView, NoteUpdateView } from "../../shared/messages/notes.ts";
import type { TranscriptReply, TranscriptView } from "../../shared/messages/transcript.ts";
import { EFFORT_TIMEOUT_SECONDS } from "../../shared/settings-schema.ts";
import type { AiWiring } from "../ai.ts";
import { errorLabel, type Log } from "../log.ts";
import type { NoteStore, NoteView } from "../stores/notes.ts";
import { promptMessages } from "./overview/chunks.ts";
import type { TranscriptService } from "./transcript/index.ts";

export const NOTE_PROMPT = "note-cleanup.md";
export const NOTE_TEXT_MAX = 3000;
const TITLE_MAX = 500;
const AUTHOR_MAX = 300;
const POLISH_MAX_TOKENS = 512;

export interface NoteInput {
  readonly video: VideoKey;
  readonly atSec: number;
  /** 已经整理好的正文（概览里存为笔记），不再过模型。 */
  readonly text?: string | undefined;
}

export interface NoteSaveOptions {
  /** 真要润色一条新笔记时问一次，回 false 就只存原文。播放页来的笔记用它限频。 */
  readonly mayPolish?: () => boolean;
}

export interface NotesServiceDeps {
  readonly notes: NoteStore;
  readonly transcript: Pick<TranscriptService, "ensure" | "get">;
  readonly ai: Pick<AiWiring, "configCheck" | "freeze" | "forTask" | "prompt">;
  readonly keepAlive: KeepAlive;
  readonly guard: ClearGuard;
  readonly broadcast: (message: Broadcast) => void;
  /** 回复之后再开始润色。 */
  readonly defer: (work: () => void) => void;
  readonly log: Log;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface NotesService {
  save(input: NoteInput, options?: NoteSaveOptions): Promise<Result<NoteSaveView>>;
  list(video?: VideoKey): Promise<Result<NoteListView>>;
  update(id: string, text: string): Promise<Result<NoteUpdateView>>;
  remove(id: string): Promise<Result<EmptyRequest>>;
}

/** 存笔记时读到的字幕和视频信息；还没读到字幕的 YouTube 视频没有。 */
interface Source {
  readonly view: TranscriptView | null;
}

interface Polish {
  readonly note: NoteRecord;
  readonly context: NoteContext;
  readonly title: string;
  readonly view: TranscriptView;
}

const bare = ({ code, detail, retryAfterSec }: Failure): Failure => ({
  ok: false,
  code,
  ...(detail === undefined ? {} : { detail }),
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

const genInfo = ({ feature, promptVersion, model, effort }: FrozenGen) => ({ feature, promptVersion, model, effort });

const budgetOf = (gen: FrozenGen): number => keepAliveBudget(EFFORT_TIMEOUT_SECONDS[gen.effort] * 1000);

export function createNotesService(deps: NotesServiceDeps): NotesService {
  // 润色还在跑的笔记，只在内存里：后台被回收后不会留下一直「润色中」的笔记。
  const polishing = new Set<string>();

  const shown = (note: NoteView): NoteItemView => (polishing.has(note.id) ? { ...note, polishing: true } : note);

  const changed = (video: VideoKey): void => deps.broadcast({ type: "notes.changed", video });

  // 写满按名字和文案认：浏览器给的说法随版本变，有时一个字都没有。别的写入错误交给路由按后台出错回。
  function writeFailure(error: unknown): Failure {
    if (isQuotaError(error)) return fail("STORAGE_FULL");
    throw error;
  }

  async function localSource(ref: VideoRef): Promise<Result<Source>> {
    const cached: TranscriptReply = await deps.transcript.get(ref, { mode: "cache-only" });
    return ok({ view: cached.ok ? cached.value : null });
  }

  async function sourceOf(ref: VideoRef): Promise<Result<Source>> {
    if (ref.platform === "youtube") return localSource(ref);
    const snapshot = await deps.transcript.ensure(ref);
    return snapshot.ok ? ok({ view: snapshot.value.view }) : bare(snapshot);
  }

  async function polishText({ context, title }: Polish, gen: FrozenGen): Promise<string | null> {
    const variables = {
      videoTitle: title || "未知",
      fullContext: context.fullContext,
      beforeText: context.beforeText || "（无）",
      targetText: context.targetText,
      afterText: context.afterText || "（无）",
    };
    const { text } = await deps.ai.forTask(gen).requestAiCompletion({
      maxTokens: POLISH_MAX_TOKENS,
      responseFormat: NOTE_QUOTE,
      messages: promptMessages(deps.ai.prompt(NOTE_PROMPT), variables),
    });
    const parsed = parseLooseJson(text) as { readonly quote?: unknown } | null;
    return typeof parsed?.quote === "string" && parsed.quote.trim() ? parsed.quote.trim().slice(0, NOTE_TEXT_MAX) : null;
  }

  // 润色完把正文换掉。笔记可能已经删了、被用户改过，那就什么都不动。
  async function polish(job: Polish, gen: FrozenGen, since: ClearEpoch | undefined): Promise<void> {
    let polished: string | null = null;
    try {
      polished = await polishText(job, gen);
    } catch (error) {
      deps.log.warn("笔记润色失败，保留原文", errorLabel(error));
    }
    if (!polished || polished === job.note.text) return;
    const derived: Derived = { basis: { source: "transcript", transcript: job.view.transcript.ref }, gen: genInfo(gen) };
    await deps.notes.update(
      (current) => {
        const target = current.find((note) => note.id === job.note.id);
        if (!target || target.text !== job.note.text) return {};
        return { put: [{ ...target, text: polished as string, derived, updatedAt: deps.now() }] };
      },
      { since },
    );
  }

  // 回复之前就撑着 worker：润色排在回复之后，中间不能被回收。润色写完（或没写成）通知页面刷新。
  function startPolish(job: Polish, gen: FrozenGen, since: ClearEpoch | undefined): void {
    polishing.add(job.note.id);
    const release = deps.keepAlive.hold(budgetOf(gen));
    deps.defer(() => {
      polish(job, gen, since)
        .catch((error: unknown) => deps.log.warn("笔记润色没写回", errorLabel(error)))
        .finally(() => {
          polishing.delete(job.note.id);
          release();
          changed(job.note.video);
        });
    });
  }

  // 用完整的配置检查，不只看密钥填没填：地址不合法、没选模型时同样发不出润色请求。
  async function polishConfig(): Promise<FrozenGen | null> {
    try {
      return (await deps.ai.configCheck()).ready ? await deps.ai.freeze("notes") : null;
    } catch {
      return null;
    }
  }

  return {
    async save({ video, atSec, text: manualText }, { mayPolish } = {}) {
      const ref = parseVideoKey(video);
      if (!ref) return fail("INVALID_REQUEST");
      const manual = (manualText ?? "").trim();
      if (manual.length > NOTE_TEXT_MAX) return fail("NOTE_TOO_LONG");
      const since = deps.guard.epoch();
      const seconds = Math.max(0, Math.floor(Number(atSec) || 0));
      // 带着整理好的正文（比如从概览摘的）不要字幕，视频信息只看本机有的：没登录、被限流时照样存得下。
      const source = manual ? await localSource(ref) : await sourceOf(ref);
      if (!source.ok) return source;
      const { view } = source.value;

      let noteText = manual;
      let context: NoteContext | null = null;
      if (!manual && view) {
        context = noteContextAt(view.transcript.cues, seconds);
        if (!context) return fail("NO_TRANSCRIPT");
        noteText = [context.beforeText, context.targetText, context.afterText].filter(Boolean).join(" ");
      }
      // 还没读到字幕的 YouTube 视频只存时间点；别的站读不到字幕时上面已经报了。
      let gen = context ? await polishConfig() : null;
      const at = deps.now();
      const note: NoteRecord = {
        id: `note_${deps.newId()}`,
        kind: "note",
        origin: "user",
        video,
        snapshot: { title: (view?.info.title ?? "").slice(0, TITLE_MAX), author: (view?.info.author ?? "").slice(0, AUTHOR_MAX) },
        atSec: seconds,
        text: noteText,
        ...(context ? { quote: context.targetText } : {}),
        createdAt: at,
        updatedAt: at,
      };

      let limited = false;
      let outcome: { readonly duplicate: NoteRecord } | { readonly saved: NoteRecord } | null;
      try {
        // 同一视频同一秒只留一条：连按两下、重复点「存为笔记」都只存一次。去重在写队列里做，并发时也不会两边都插进去。
        outcome = await deps.notes.update<{ readonly duplicate: NoteRecord } | { readonly saved: NoteRecord }>((current) => {
          const existing = current.find((item) => item.video === video && item.atSec === seconds);
          if (existing) return { result: { duplicate: existing } };
          // 去重之后再问名额：重复的那次没存东西，不该占掉一次润色。
          if (gen && mayPolish && !mayPolish()) {
            gen = null;
            limited = true;
          }
          return { put: [note], result: { saved: note } };
        }, { since });
      } catch (error) {
        return writeFailure(error);
      }
      if (!outcome) return fail("LOCAL_DATA_CLEARED");
      // 对调用方来说已经有了也算存上：按钮照常显示「已保存」，不再通知刷新。
      if ("duplicate" in outcome) return ok({ note: shown(deps.notes.view(outcome.duplicate)), duplicate: true });
      changed(video);
      if (gen && context && view) startPolish({ note, context, title: view.info.title, view }, gen, since);
      const item = shown(deps.notes.view(note));
      return ok(limited ? { note: item, polishLimited: true } : { note: item });
    },

    async list(video) {
      const notes = video === undefined ? await deps.notes.all() : await deps.notes.byVideo(video);
      return ok({ notes: notes.map(shown) });
    },

    async update(id, input) {
      const text = input.trim();
      if (!text) return fail("EMPTY_NOTE");
      if (text.length > NOTE_TEXT_MAX) return fail("NOTE_TOO_LONG");
      const since = deps.guard.epoch();
      let outcome: { readonly note: NoteRecord | null } | null;
      try {
        outcome = await deps.notes.update<{ readonly note: NoteRecord | null }>((current) => {
          const target = current.find((note) => note.id === id);
          if (!target) return { result: { note: null } };
          // 用户改过的正文不再是模型写的，不再记润色的依据。
          const { derived: _derived, ...rest } = target;
          const updated: NoteRecord = { ...rest, text, updatedAt: deps.now() };
          return { put: [updated], result: { note: updated } };
        }, { since });
      } catch (error) {
        return writeFailure(error);
      }
      if (!outcome) return fail("LOCAL_DATA_CLEARED");
      const updated = outcome.note;
      if (!updated) return fail("NOTE_NOT_FOUND");
      changed(updated.video);
      return ok({ note: shown(deps.notes.view(updated)) });
    },

    async remove(id) {
      let removed: { readonly video: VideoKey | null } | null;
      try {
        removed = await deps.notes.update<{ readonly video: VideoKey | null }>((current) => {
          const target = current.find((note) => note.id === id);
          return target ? { remove: [id], result: { video: target.video } } : { result: { video: null } };
        });
      } catch (error) {
        return writeFailure(error);
      }
      if (!removed) return fail("LOCAL_DATA_CLEARED");
      if (removed.video) changed(removed.video);
      return ok({});
    },
  };
}
