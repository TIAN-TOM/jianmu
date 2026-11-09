// 问答、划词解释和笔记三个服务的测试架子：任务运行器、两个仓储、清除闸门和保活都是真的，计时器手动推进；
// 字幕是按给定字幕条交快照的替身，模型服务是按功能回复的替身。笔记的后台润色排在 0 毫秒的计时器上，测试 fire(0) 放行。
import { createExplainService, type ExplainService } from "../../src/background/services/explain.ts";
import { createNotesService, type NotesService } from "../../src/background/services/notes.ts";
import { createQaService, type QaService } from "../../src/background/services/qa.ts";
import type { TranscriptService, TranscriptSnapshot } from "../../src/background/services/transcript/index.ts";
import { createNoteStore, type NoteStore } from "../../src/background/stores/notes.ts";
import { createQaStore, type QaStore } from "../../src/background/stores/qa.ts";
import { createTaskRunner, type TaskRunner } from "../../src/background/tasks.ts";
import { createClearGuard, type ClearGuard } from "../../src/core/clear-guard.ts";
import { fail, ok, type ErrorCode, type Result } from "../../src/core/errors.ts";
import type { NoteRecord, OverviewRecord, QaRecord } from "../../src/core/notes/records.ts";
import type { FrozenGen, TaskKind } from "../../src/core/tasks.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../src/core/video-ref.ts";
import type { ObjectStoreDriver } from "../../src/platform/idb.ts";
import { createKeepAlive } from "../../src/platform/keepalive.ts";
import type { Broadcast } from "../../src/shared/messages.ts";
import type { QaAnswerView } from "../../src/shared/messages/qa.ts";
import type { CueView, TranscriptReply, TranscriptView } from "../../src/shared/messages/transcript.ts";
import { createFakeAi, type FakeAi, type FakeAiOptions } from "./fake-ai.ts";
import { SAMPLE_ID } from "./fake-site-service.ts";
import { manualTimers, type ManualTimers } from "./manual-timers.ts";
import { createMemoryDriver } from "./memory-driver.ts";
import { until } from "./wait-until.ts";

export const START = 1_800_000_000_000;
export const REF: VideoRef = { platform: "bilibili", videoId: SAMPLE_ID, segment: 1 };
export const VIDEO: VideoKey = videoKey(REF);
export const SECOND_PART: VideoKey = videoKey({ ...REF, segment: 2 });
export const OTHER: VideoKey = videoKey({ platform: "bilibili", videoId: "BV1Sample002", segment: 1 });
export const TUBE: VideoKey = videoKey({ platform: "youtube", videoId: "tube-sample" });
/** 保活每隔多久调一次扩展接口。 */
export const INTERVAL = 20_000;

// 提示词替身：用户提示词里带着各变量，测试按它们核对送了什么。
export const PROMPTS: Readonly<Record<string, string>> = {
  "qa.md": ["## 系统提示词", "```", "问答/系统", "```", "## 用户提示词", "```", "标题：{videoTitle}", "问题：{question}", "{transcriptText}", "```", ""].join("\n"),
  "explain.md": ["## 系统提示词", "```", "解释/系统", "```", "## 用户提示词", "```", "视频：{videoTitle}", "选中：{selectedText}", "上下文：{transcriptContext}", "```", ""].join("\n"),
  "note-cleanup.md": ["## 系统提示词", "```", "润色/系统", "```", "## 用户提示词", "```", "目标：{targetText}", "```", ""].join("\n"),
};

export const cue = (start: number, text: string, duration = 10): CueView => ({ start, duration, text });

/** 按字幕条拼一份取字幕的结果：分段和字幕条一一对应。 */
export function transcriptView(video: VideoKey, cues: readonly CueView[], info: Partial<TranscriptView["info"]> = {}): TranscriptView {
  return {
    video,
    info: { title: "标题", author: "UP 主", description: "", durationSec: 300, ...info },
    transcript: {
      ref: { video, kind: "human", lang: "zh-CN", fingerprint: `fp-${cues.map((item) => item.text).join("|")}` },
      trackId: "zh-CN",
      label: "中文",
      cues,
      segments: cues.map((item, index) => ({ id: `s${index}`, start: item.start, text: item.text, texts: [item.text] })),
    },
    tracks: [],
    chapters: [],
    fromCache: true,
  };
}

/** 每个视频的字幕：给字幕条，或者给取字幕失败的码。没给的视频报没有字幕。 */
export type TranscriptScript = Readonly<Record<string, readonly CueView[] | ErrorCode>>;

export interface StudyHarnessOptions {
  readonly transcripts?: TranscriptScript;
  readonly info?: Partial<TranscriptView["info"]>;
  readonly ai?: FakeAiOptions;
  /** 本机已有的概览：问答拿它的章节给检索加权。 */
  readonly overview?: OverviewRecord | null;
  readonly notes?: readonly NoteRecord[];
  readonly qa?: readonly QaRecord[];
  readonly wrapNotes?: (inner: ObjectStoreDriver<NoteRecord>) => ObjectStoreDriver<NoteRecord>;
  readonly wrapQa?: (inner: QaStore) => QaStore;
  /** AI 配置可不可用：决定笔记要不要润色。 */
  readonly aiReady?: boolean;
}

export interface Logged {
  readonly level: "warn" | "error";
  readonly label: string;
}

export interface StudyHarness {
  readonly qa: QaService;
  readonly explain: ExplainService;
  readonly notes: NotesService;
  readonly tasks: TaskRunner;
  readonly qaStore: QaStore;
  readonly noteStore: NoteStore;
  readonly noteDriver: ObjectStoreDriver<NoteRecord>;
  readonly guard: ClearGuard;
  readonly timers: ManualTimers;
  readonly fake: FakeAi;
  readonly broadcasts: Broadcast[];
  readonly logs: Logged[];
  readonly pings: () => number;
  /** 取过几次字幕：完整读取和只看缓存分开数。 */
  readonly reads: () => { readonly ensure: number; readonly cacheOnly: number };
  /** 登记一个任务，交回任务号。 */
  register(kind: TaskKind, input: unknown, video?: VideoKey): Promise<string>;
  /** 登记并提问。 */
  ask(question: string, video?: VideoKey): { readonly taskId: Promise<string>; readonly result: Promise<Result<QaAnswerView>> };
  /** 放行排着的润色，等它们都收尾。别的任务也撑着保活时不能用。 */
  flushPolish(): Promise<void>;
}

const genOf = (feature: string): FrozenGen => ({ feature, baseUrl: "https://ai.example.test/v1", model: `${feature}-model`, effort: "off", promptVersion: `${feature}-v1` });

export function studyHarness(options: StudyHarnessOptions = {}): StudyHarness {
  const timers = manualTimers(START);
  const fake = createFakeAi({ prompts: PROMPTS, config: { ready: options.aiReady ?? true, errors: [] }, ...options.ai });
  const guard = createClearGuard();
  const broadcasts: Broadcast[] = [];
  const logs: Logged[] = [];
  const log = {
    warn: (label: unknown) => void logs.push({ level: "warn", label: String(label) }),
    error: (label: unknown) => void logs.push({ level: "error", label: String(label) }),
  };
  let pings = 0;
  const keepAlive = createKeepAlive({ ping: () => (pings += 1), now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  let ids = 0;
  const newId = () => `id-${(ids += 1)}`;
  const tasks = createTaskRunner({ ai: fake.ai, keepAlive, timers, broadcast: (message) => void broadcasts.push(message), newId });

  const scripts: TranscriptScript = options.transcripts ?? { [VIDEO]: [cue(0, "字幕句子", 60)] };
  const counts = { ensure: 0, cacheOnly: 0 };
  const replyOf = (ref: VideoRef): TranscriptReply => {
    const video = videoKey(ref);
    const script = scripts[video];
    if (script === undefined) return fail("NO_CAPTIONS");
    if (typeof script === "string") return fail(script);
    return { ok: true, value: transcriptView(video, script, options.info) };
  };
  const transcript: Pick<TranscriptService, "ensure" | "get"> = {
    async ensure(ref): Promise<Result<TranscriptSnapshot>> {
      counts.ensure += 1;
      const reply = replyOf(ref);
      return reply.ok ? ok({ view: reply.value, generation: 0 }) : fail(reply.code);
    },
    async get(ref, { mode }) {
      if (mode !== "cache-only") throw new Error("测试里只看缓存");
      counts.cacheOnly += 1;
      const reply = replyOf(ref);
      return reply.ok ? reply : fail("NOT_CACHED");
    },
  };

  const qaDriver = createMemoryDriver<QaRecord>("qa", options.qa ?? []);
  const realQa = createQaStore({ driver: qaDriver, guard });
  const qaStore = options.wrapQa ? options.wrapQa(realQa) : realQa;
  const noteDriver = createMemoryDriver<NoteRecord>("notes", options.notes ?? []);
  const noteStore = createNoteStore({
    driver: options.wrapNotes ? options.wrapNotes(noteDriver) : noteDriver,
    guard,
    canonicalUrl: ({ videoId, segment = 1 }, atSec = 0) => `https://video.example/${videoId}?p=${segment}&t=${atSec}`,
  });

  const qa = createQaService({
    tasks,
    transcript,
    overviews: { find: async () => options.overview ?? null },
    qa: qaStore,
    guard,
    prompt: fake.ai.prompt,
    chunkOptions: async () => ({}),
    log,
    now: timers.now,
    newId,
  });
  const explain = createExplainService({ tasks, transcript, prompt: fake.ai.prompt, log });
  const notes = createNotesService({
    notes: noteStore,
    transcript,
    ai: fake.ai,
    keepAlive,
    guard,
    broadcast: (message) => void broadcasts.push(message),
    defer: (work) => void timers.setTimeout(work, 0),
    log,
    now: timers.now,
    newId,
  });

  async function register(kind: TaskKind, input: unknown, video: VideoKey = VIDEO): Promise<string> {
    const registered = await tasks.register({ kind, origin: "user", video, input, gen: genOf(kind), followsPage: false }, {});
    if (!("task" in registered)) throw new Error(`没登记上：${JSON.stringify(registered)}`);
    return registered.task.id;
  }

  return {
    qa,
    explain,
    notes,
    tasks,
    qaStore,
    noteStore,
    noteDriver,
    guard,
    timers,
    fake,
    broadcasts,
    logs,
    pings: () => pings,
    reads: () => ({ ...counts }),
    register,
    ask(question, video = VIDEO) {
      const taskId = register("qa", { question }, video);
      return { taskId, result: taskId.then((id) => qa.ask(id, video)) };
    },
    async flushPolish() {
      timers.fire(0);
      // 润色从排上到收尾一直撑着保活：排着的润色和保活的计时器都没了，才算润色都收了尾。
      const settled = await until(() => timers.due(0) === 0 && timers.due(INTERVAL) === 0);
      if (!settled) throw new Error("润色一直没收尾");
    },
  };
}
