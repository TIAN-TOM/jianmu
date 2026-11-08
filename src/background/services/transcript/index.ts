// 取字幕服务：缓存优先，然后是内存里记着的对不上的字幕、用户导入的字幕文件，都没有再向平台读，官方总结跟着一起问。
// 侧边栏和卡片常为同一个视频同时取字幕，同一视频同一语言的在途读取合并成一次；卡片只用轻量读取（light.ts）。
// 结果按发起时的视频写回缓存，读取途中侧边栏换了视频也不写到别的视频上。缓存仓储里已有清除闸门，这里不再包一层。
import type { ClearEpoch, ClearGuard, ClearScope } from "../../../core/clear-guard.ts";
import { fail, ok, type ErrorCode, type Result } from "../../../core/errors.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../../core/video-ref.ts";
import type { EmptyRequest } from "../../../shared/messages/core.ts";
import type { ImportReceipt } from "../../../shared/messages/imports.ts";
import type { GuidesReply, TranscriptFailure, TranscriptReadMode, TranscriptReply } from "../../../shared/messages/transcript.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { ImportRecord, ImportStore } from "../../stores/imports.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { Timers } from "../../tasks.ts";
import { assembleImported, createImports } from "./imports.ts";
import { createLight, type JoinableRead, type ReadingGuides } from "./light.ts";
import { createMismatchMemory, timelineMismatch } from "./memory.ts";
import { createOfficials, type OfficialRead } from "./official.ts";
import { readFromSite, type ReadGuides, type SiteAccess } from "./read.ts";
import {
  chaptersView,
  createTranscriptWriter,
  hasTranscript,
  infoView,
  officialView,
  tracksView,
  viewOf,
  type CachedTranscript,
  type StoredOfficial,
  type TranscriptCache,
  type TranscriptRecord,
  type TranscriptWriter,
} from "./write.ts";

export type { SiteAccess } from "./read.ts";

export interface TranscriptDeps {
  readonly sites: SiteAccess;
  readonly cache: TranscriptCache;
  readonly imports: ImportStore;
  /** 轻量读取带回本机已有的概览和结论。 */
  readonly overviews: Pick<OverviewStore, "find">;
  readonly guard: ClearGuard;
  /** 视频信息没读到时拿标签页的标题显示。 */
  readonly tabTitle: (tabId: number) => Promise<string | null>;
  readonly timers: Pick<Timers, "now" | "setTimeout" | "clearTimeout">;
  readonly log: Log;
  /** 经页面读取的站要核对页面上还是不是这个视频，留给那时接上；直接向平台读的站靠视频信息核对和这次读取的绑定。 */
  readonly stillCurrent?: (ref: VideoRef) => Promise<boolean>;
  /** 播放器字幕取不到时，拿官方总结附带的 AI 字幕兜底。生产里由装配函数按官方总结模块的开关给。 */
  readonly officialCaptionsFallback: boolean;
}

export interface TranscriptGetOptions {
  readonly mode: Exclude<TranscriptReadMode, "light">;
  readonly lang?: string | undefined;
  readonly fresh?: boolean | undefined;
  readonly tabId?: number | undefined;
}

export interface TranscriptService {
  get(ref: VideoRef, options: TranscriptGetOptions): Promise<TranscriptReply>;
  /** 卡片的轻量读取：视频信息、官方总结和本机已有的概览，不读字幕。 */
  light(ref: VideoRef): Promise<GuidesReply>;
  /** 原视频还在不在：只有平台明确说找不到才算不在，别的失败都放行。 */
  checkAvailable(ref: VideoRef): Promise<boolean>;
  /** 导入字幕文件：解析、存下，作废缓存里原来的字幕。不向平台发请求。 */
  importFile(ref: VideoRef, file: { readonly name: string; readonly text: string }): Promise<Result<ImportReceipt>>;
  /** 移除导入的字幕文件，作废缓存里用它组装的那份。 */
  removeImport(ref: VideoRef): Promise<Result<EmptyRequest>>;
  /** 这个视频的字幕代数：导入、移除字幕文件时加一。拿字幕快照做事的调用方写回前核对它。 */
  generation(ref: VideoRef): number;
  /** 缓存记录的读—改—写，和读取的写回排在同一条队列里。 */
  readonly writer: TranscriptWriter;
  /** 清除本机数据时调：忘掉内存里记着的字幕和轻量读取记着的；在途读取不再给之后的调用合并，回来时也不写缓存和内存。 */
  forget(scope: ClearScope): void;
}

// 这几种情况读不到视频信息，用标签页标题顶上。
const TITLE_FALLBACK: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["NEED_LOGIN", "RATE_LIMITED", "UNPLAYABLE"]);

/** 缓存里已有平台或导入的字幕：官方总结附带的字幕不顶替它。只认真进了缓存的，内存里记着的对不上的那份不算。 */
const keepsCaptions = (current: CachedTranscript | null): current is TranscriptRecord => hasTranscript(current) && current.transcript.ref.kind !== "official-ai";

const keyOf = (ref: VideoRef): VideoKey | null => {
  try {
    return videoKey(ref);
  } catch {
    return null;
  }
};

/** 每个调用方拿自己的一层外壳，谁往结果上补字段都不影响一起等的另一方。 */
const shell = (reply: TranscriptReply): TranscriptReply => (reply.ok ? { ok: true, value: { ...reply.value } } : { ...reply });

/** 一次读取开头记下的：清除代数、内存记录的代数、这个视频的字幕代数。回来时任何一个变了，结果只交给调用方。 */
interface ReadStart {
  readonly since: ClearEpoch | undefined;
  readonly memory: number;
  readonly generation: number;
}

/** 一次在途的完整读取：读到视频信息以后登记下来，卡片等不及时接着用。 */
interface InFlight {
  readonly video: VideoKey;
  readonly reply: Promise<TranscriptReply>;
  readonly reading: { current?: ReadingGuides };
}

export function createTranscriptService(deps: TranscriptDeps): TranscriptService {
  const { cache, guard, timers, log } = deps;
  /** 在途读取，键是「视频、语言、要不要重新列轨」。 */
  const inFlight = new Map<string, InFlight>();
  const memory = createMismatchMemory(guard);
  const generations = new Map<VideoKey, number>();
  const generationOf = (video: VideoKey): number => generations.get(video) ?? 0;

  // 缓存改了以后才发起的读取，不能再并进改之前的在途读取：那份结果是改之前的快照。已经在等的照旧拿各自的结果。
  function forgetVideo(video: VideoKey): void {
    for (const [key, entry] of inFlight) if (entry.video === video) inFlight.delete(key);
    light.drop(video);
  }

  const writer = createTranscriptWriter({ cache, changed: forgetVideo, log });
  const officials = createOfficials({
    writer,
    guard,
    timers,
    log,
    captionsFallback: deps.officialCaptionsFallback,
    patchMemory: (video, mutate) => memory.patch(video, mutate),
  });
  const imports = createImports({
    store: deps.imports,
    cache,
    writer,
    guard,
    now: timers.now,
    log,
    changed(video) {
      generations.set(video, generationOf(video) + 1);
      memory.drop(video);
      forgetVideo(video);
    },
  });

  // 卡片并进的只认没点名语言的完整读取：点名语言的可能因为没有那条轨而失败，卡片不该跟着报错。
  function joinable(video: VideoKey): JoinableRead | undefined {
    const entry = inFlight.get(JSON.stringify([video, "", false])) ?? inFlight.get(JSON.stringify([video, "", true]));
    return entry ? { reply: entry.reply, reading: () => entry.reading.current } : undefined;
  }

  const light = createLight({
    sites: deps.sites,
    cache,
    overviews: deps.overviews,
    officials,
    guard,
    timers,
    log,
    joinable,
    fromCache: (ref, video, cached) => fromCache(ref, video, cached),
  });

  async function guidesFailure(failure: TranscriptFailure, guides: ReadGuides, cached: CachedTranscript | null, tabId: number | undefined): Promise<TranscriptFailure> {
    const info = guides.info ?? cached?.info;
    const tabTitle = !info && tabId !== undefined && TITLE_FALLBACK.has(failure.code) ? await deps.tabTitle(tabId) : null;
    return {
      ...failure,
      ...(info ? { info: infoView(info) } : {}),
      ...(tabTitle ? { tabTitle } : {}),
      ...(guides.tracks ? { tracks: tracksView(guides.tracks) } : {}),
      ...(guides.chapters ? { chapters: chaptersView(guides.chapters) } : {}),
    };
  }

  // 读到一份字幕以后：对得上的写缓存；对不上的只记在内存里，缓存里已有对得上的就以缓存为准。
  // keep：轮到写的那一刻缓存里已有的就留着它，交回它（官方总结附带字幕的兜底不顶替平台字幕）。
  async function settle(
    video: VideoKey,
    record: TranscriptRecord,
    lang: string,
    start: ReadStart,
    persist: boolean,
    keep?: (current: CachedTranscript | null) => current is TranscriptRecord,
    late?: Promise<OfficialRead>,
  ): Promise<TranscriptReply> {
    const stale = (): boolean => guard.clearedSince(start.since, "cache") || memory.epoch() !== start.memory || generationOf(video) !== start.generation;
    const mismatch = timelineMismatch(record);
    const marks = mismatch ? ({ subtitleMismatch: true } as const) : {};
    // 读取途中清除过本机数据或换过字幕文件：结果照样交给发起的调用方，不写缓存，也不记进内存。
    if (stale()) return ok(viewOf(video, record, false, marks));
    if (!mismatch) {
      // 写不进去（存储出错）也照样把这次读到的交给调用方。
      const saved = persist ? await writer.save(video, record, start.since, stale, keep) : null;
      if (saved?.kept) return ok(viewOf(video, saved.kept, true));
      if (!stale()) memory.drop(video);
      return ok(viewOf(video, record, false));
    }
    // 刷新、换语言时缓存里可能已有对得上的字幕：以它为准，免得页面和后台各用一份。导入的是用户自己选的，照样用它。
    const stored = record.transcript.ref.kind === "imported" ? null : await cache.load(video);
    if (hasTranscript(stored)) {
      if (hasTranscript(stored, lang)) return ok(viewOf(video, stored, true, { refreshMismatched: true }));
      return { ...fail("SUBTITLE_MISMATCH"), info: infoView(record.info), tracks: tracksView(record.tracks), chapters: chaptersView(record.chapters) };
    }
    if (!stale()) {
      memory.remember(video, record, start.since);
      // 官方总结可能在上面核对缓存的工夫回来了：那时内存里还没有这份，回填落了空，这里补上。
      if (late && record.official?.status === "pending") void late.then(({ record: official }) => patchPending(video, record, official, start.since));
    }
    return ok(viewOf(video, record, false, marks));
  }

  function patchPending(video: VideoKey, record: TranscriptRecord, official: StoredOfficial, since: ClearEpoch | undefined): void {
    if (guard.clearedSince(since, "cache")) return;
    const waiting = (current: TranscriptRecord): boolean => current.official?.status === "pending" && current.info.mediaVersion === record.info.mediaVersion;
    memory.patch(video, (current) => (waiting(current) ? { ...current, official } : null));
  }

  async function fromImport(ref: VideoRef, video: VideoKey, imported: ImportRecord, cached: CachedTranscript | null, start: ReadStart, tabId: number | undefined): Promise<TranscriptReply> {
    const title = !cached?.info && !imported.info && tabId !== undefined ? await deps.tabTitle(tabId) : null;
    const { record, known } = await assembleImported(ref, video, imported, cached, title);
    // 视频信息是拿标题顶上的就不进缓存：别的读取会把它当成读到的视频信息。导入的文件一直在，下次再组装。
    return settle(video, record, "", start, known);
  }

  // 播放器字幕取不到：能兜底就用官方总结附带的字幕，不然带上已经知道的报原来的错。
  async function afterFailure(
    video: VideoKey,
    read: { readonly failure: TranscriptFailure; readonly guides: ReadGuides; readonly official?: Promise<OfficialRead> | undefined },
    cached: CachedTranscript | null,
    lang: string,
    start: ReadStart,
    tabId: number | undefined,
  ): Promise<TranscriptReply> {
    const official = read.official ? await read.official : undefined;
    const fallback = official ? await officials.fallback(video, read.failure, official, lang, read.guides) : null;
    if (fallback && !keepsCaptions(await cache.load(video))) return settle(video, fallback, "", start, true, keepsCaptions);
    const failure = await guidesFailure(read.failure, read.guides, cached, tabId);
    return official ? { ...failure, official: officialView(official.record) } : failure;
  }

  // 命中缓存：过了重问时间的官方总结在后台重问，这次先交缓存里的；只有占位（上次先交了字幕）要等，
  // 它多半就是还在路上的那次，不等的话页面会说成没有官方总结。
  // 用户导入的字幕只用本机的：官方总结不向平台重问，占位只接还在路上的那次回填。
  async function fromCache(ref: VideoRef, video: VideoKey, cached: TranscriptRecord): Promise<TranscriptReply> {
    if (cached.transcript.ref.kind === "imported") return ok(viewOf(video, await officials.settled(video, cached), true));
    const site = deps.sites.service(ref.platform);
    const ask = site?.readOfficialSummary?.bind(site);
    const refreshing = ask ? officials.refresh(video, cached, (info) => ask(info, deps.sites.ctx(ref.platform, { signal: new AbortController().signal }))) : null;
    if (refreshing && cached.official?.status === "pending") return ok(viewOf(video, { ...cached, official: await refreshing }, true));
    return ok(viewOf(video, cached, true));
  }

  async function load(ref: VideoRef, video: VideoKey, lang: string, fresh: boolean, tabId: number | undefined, reading: InFlight["reading"]): Promise<TranscriptReply> {
    const start: ReadStart = { since: guard.epoch(), memory: memory.epoch(), generation: generationOf(video) };
    const cached = await cache.load(video);
    if (!fresh && hasTranscript(cached, lang)) return fromCache(ref, video, cached);
    const remembered = fresh ? null : memory.get(video, lang);
    if (remembered) return ok(viewOf(video, remembered, false, { subtitleMismatch: true }));
    // 导入的字幕排在读视频信息之前，命中就不向平台发任何请求；刷新也用它。点名语言时要的是平台的那条轨。
    const imported = lang ? null : await imports.load(video);
    if (imported) return fromImport(ref, video, imported, cached, start, tabId);
    const site = deps.sites.service(ref.platform);
    if (!site) return fail("SITE_UNSUPPORTED");
    const ask = site.readOfficialSummary?.bind(site);
    const read = await readFromSite({
      site,
      ref,
      video,
      lang,
      fresh: fresh || lang !== "",
      knownTracks: (cached?.tracks.length ?? 0) > 0,
      ctx: (signal) => deps.sites.ctx(ref.platform, { signal, tabId }),
      timers,
      // 刷新时不接轻量读取记着的官方总结，要的就是重新问。
      official: ask ? officials.forRead(video, cached, { lang, refresh: fresh, remembered: fresh ? undefined : () => light.remembered(video) }, ask) : undefined,
      onInfo: (info, official) => {
        reading.current = { info, official };
      },
    });
    if (!read.ok) return afterFailure(video, read, cached, lang, start, tabId);
    return settle(video, await officials.attach(video, read.record, read.official, start.since), lang, start, true, undefined, read.official);
  }

  // 只读缓存：缓存和内存里记着的那份，导入的文件不拿来组装，一个请求都不发。官方总结的占位只接还在路上的回填。
  async function cacheOnly(video: VideoKey, lang: string): Promise<TranscriptReply> {
    const cached = await cache.load(video);
    if (hasTranscript(cached, lang)) return ok(viewOf(video, await officials.settled(video, cached), true));
    const remembered = memory.get(video, lang);
    return remembered ? ok(viewOf(video, await officials.settled(video, remembered), false, { subtitleMismatch: true })) : fail("NOT_CACHED");
  }

  return {
    async get(ref, { mode, lang = "", fresh = false, tabId }) {
      const video = keyOf(ref);
      if (!video) return fail("INVALID_REQUEST");
      // 这个视频正在导入或移除字幕文件：等做完再读。
      const changing = imports.pending(video);
      if (changing) await changing;
      // 只读缓存很便宜，不进合并表。
      if (mode === "cache-only") return cacheOnly(video, lang);
      const key = JSON.stringify([video, lang, fresh]);
      let entry = inFlight.get(key);
      if (!entry) {
        const reading: InFlight["reading"] = {};
        const reply = load(ref, video, lang, fresh, tabId, reading);
        const created = { video, reply, reading };
        entry = created;
        inFlight.set(key, created);
        const settled = (): void => {
          if (inFlight.get(key) === created) inFlight.delete(key);
        };
        reply.then(settled, settled);
      }
      return shell(await entry.reply);
    },

    async light(ref) {
      const video = keyOf(ref);
      if (!video) return fail("INVALID_REQUEST");
      const changing = imports.pending(video);
      if (changing) await changing;
      return light.read(ref, video);
    },

    async checkAvailable(ref) {
      const site = deps.sites.service(ref.platform);
      if (!site || !keyOf(ref)) return true;
      try {
        const read = await site.readVideoInfo(ref, deps.sites.ctx(ref.platform, { signal: new AbortController().signal }));
        return read.ok || read.code !== "NOT_FOUND";
      } catch (error) {
        // 查不出来时不挡用户，让平台自己说。
        log.warn("查原视频还在不在失败", errorLabel(error));
        return true;
      }
    },

    importFile(ref, file) {
      const video = keyOf(ref);
      return video ? imports.add(video, file) : Promise.resolve(fail("INVALID_REQUEST"));
    },

    removeImport(ref) {
      const video = keyOf(ref);
      return video ? imports.remove(video) : Promise.resolve(fail("INVALID_REQUEST"));
    },

    generation(ref) {
      const video = keyOf(ref);
      return video ? generationOf(video) : 0;
    },

    writer,

    // 两种清除都清：内存里记着的只是缓存的替身，清除缓存也该没有。
    forget(_scope) {
      inFlight.clear();
      memory.forget();
      officials.forget();
      light.forget();
    },
  };
}
