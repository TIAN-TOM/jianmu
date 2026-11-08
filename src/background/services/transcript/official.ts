// 官方总结并进取字幕：和字幕列表同时问，字幕先到时最多再等一小会儿，等不到就先交字幕、存个占位，回来后填回。
// 排队中、要登录、没问成的过一阵再问；命中缓存时在后台重问，只写回还在的那条。同一视频同一媒体版本同时只问一次。
// 附带的 AI 字幕默认不当字幕用；打开时只在播放器字幕取不到、没点名语言时兜底，被限流、要登录、看不了时不用。
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import type { ErrorCode, Failure } from "../../../core/errors.ts";
import { officialFingerprint, transcriptFingerprint } from "../../../core/transcript/fingerprint.ts";
import { OFFICIAL_SUBTITLE_LABEL } from "../../../core/transcript/sources.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import type { Cue, OfficialSummary, SiteCtx, SiteResult, VideoInfo } from "../../../sites/types.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { Timers } from "../../tasks.ts";
import type { ReadGuides } from "./read.ts";
import { recordOf, type CachedTranscript, type StoredOfficial, type TranscriptRecord, type TranscriptWriter } from "./write.ts";

/** 官方总结附带的 AI 字幕当不当字幕用。这份字幕对观众是否可见还没确认，先不用。 */
export const OFFICIAL_CAPTIONS_FALLBACK = false;
/** 字幕已经读到时，官方总结最多再等这么久。它和字幕列表同时问，通常早就回来了。 */
export const OFFICIAL_GRACE_MS = 1_500;
/** 排队中、要登录、没问成的，过这么久再问。 */
export const OFFICIAL_RETRY_MS = 10 * 60_000;

/** 兜底字幕在字幕轨里的编号和语言：不是平台列出的哪一条，正文固定是中文。 */
const OFFICIAL_TRACK_ID = "official-ai";
const OFFICIAL_CAPTIONS_LANG = "zh-CN";

const RETRY_STATUSES: ReadonlySet<string> = new Set(["queued", "need-login", "failed"]);
// 有定论的：轻量读取记着的这几种，完整读取接着用，不管过了多久都不重问。
const SETTLED_STATUSES: ReadonlySet<string> = new Set(["ok", "none", "unsupported"]);
// 播放器字幕取不到时，这几种可以拿附带的字幕兜底；被限流、要登录、看不了、找不到时一律不兜底。
const FALLBACK_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["NO_CAPTIONS", "SUBTITLE_TRACK_MISSING", "EMPTY_CAPTION_FILE", "MALFORMED", "NETWORK", "TIMEOUT"]);

/** 问一次官方总结的结果：要存下的那份，加上附带的 AI 字幕。附带的字幕只在兜底时用，不存。 */
export interface OfficialRead {
  readonly record: StoredOfficial;
  readonly cues: readonly Cue[];
}

export type AskOfficial = (info: VideoInfo, ctx: SiteCtx) => Promise<SiteResult<OfficialSummary>>;

export interface OfficialDeps {
  readonly writer: TranscriptWriter;
  readonly guard: ClearGuard;
  readonly timers: Pick<Timers, "now" | "setTimeout" | "clearTimeout">;
  readonly log: Log;
  readonly captionsFallback: boolean;
  /** 迟到的官方总结回来时，内存里记着的那份（时间轴对不上的字幕）也换上；mutate 交回 null 表示不换。 */
  readonly patchMemory: (video: VideoKey, mutate: (record: TranscriptRecord) => TranscriptRecord | null) => void;
}

/** 卡片的轻量读取记着的官方总结：有定论的完整读取接着用，没定论的重问，问到的换给它。 */
export interface RememberedOfficial {
  readonly mediaVersion: string | undefined;
  readonly read: OfficialRead;
  readonly replace: (fresh: OfficialRead) => void;
}

export interface ForReadOptions {
  readonly lang: string;
  readonly refresh: boolean;
  /** 轻量读取记着的那份，还在读的等它读完。刷新时不给。 */
  readonly remembered?: (() => Promise<RememberedOfficial | null>) | undefined;
}

export interface Officials {
  /** 一次读取怎么拿官方总结：沿用缓存里还算数的那份，再看轻量读取记着的，否则用这次读取的环境去问。 */
  forRead(video: VideoKey, cached: CachedTranscript | null, options: ForReadOptions, ask: AskOfficial): (info: VideoInfo, ctx: SiteCtx) => Promise<OfficialRead>;
  /** 问一次官方总结：同一视频同一媒体版本在问的就并进那一次。从不失败。 */
  lookup(video: VideoKey, info: VideoInfo, read: () => Promise<SiteResult<OfficialSummary>>): Promise<OfficialRead>;
  /** 先交了字幕的读取还在等的官方总结，没有时是 undefined。 */
  lateFor(video: VideoKey): Promise<StoredOfficial> | undefined;
  /** 字幕读到了：官方总结最多再等一小会儿，等不到先放占位，回来后填回缓存。 */
  attach(video: VideoKey, record: TranscriptRecord, pending: Promise<OfficialRead> | undefined, since: ClearEpoch | undefined): Promise<TranscriptRecord>;
  /** 播放器字幕取不到时用附带字幕组装的结果：开关开着、没点名语言、这种失败可以兜底、确实附带了字幕时才有。 */
  fallback(video: VideoKey, failure: Failure, read: OfficialRead, lang: string, guides: ReadGuides): Promise<TranscriptRecord | null>;
  /** 命中缓存：过了重问时间的再问一次，写回还在的那条，交回问到的；不用重问时是 null。从不失败。 */
  refresh(video: VideoKey, record: TranscriptRecord, ask: (info: VideoInfo) => Promise<SiteResult<OfficialSummary>>): Promise<StoredOfficial> | null;
  /** 只读缓存：占位只接还在路上的那次回填，不发请求。 */
  settled(video: VideoKey, record: TranscriptRecord): Promise<TranscriptRecord>;
  /** 清除本机数据时：在途的问询和回填不再给之后的读取合并。 */
  forget(): void;
}

const EXPIRED = Symbol("expired");

export function needsRetry(official: StoredOfficial, now: number): boolean {
  if (official.status === "pending") return true;
  return RETRY_STATUSES.has(official.status) && now - official.fetchedAt >= OFFICIAL_RETRY_MS;
}

// 问询和回填按「视频、媒体版本」记：换过内容的分 P 不并进旧版本的那次。
const slotOf = (video: VideoKey, info: VideoInfo): string => JSON.stringify([video, info.mediaVersion ?? ""]);

export function createOfficials({ writer, guard, timers, log, captionsFallback, patchMemory }: OfficialDeps): Officials {
  const asking = new Map<string, Promise<OfficialRead>>();
  const late = new Map<string, Promise<StoredOfficial>>();

  const blank = (status: StoredOfficial["status"]): StoredOfficial => ({ status, summary: "", outline: [], hasCaptions: false, fetchedAt: timers.now() });

  async function readOf(result: SiteResult<OfficialSummary>): Promise<OfficialRead> {
    if (!result.ok) return { record: blank(result.code === "NEED_LOGIN" ? "need-login" : "failed"), cues: [] };
    const { status, summary, outline, cues } = result.value;
    const record: StoredOfficial = { status, summary, outline, hasCaptions: cues.length > 0, fetchedAt: timers.now() };
    return { record: status === "ok" ? { ...record, fingerprint: await officialFingerprint(record) } : record, cues };
  }

  // 从不失败：官方总结拿不到只影响它自己那一块，不连累字幕。
  function ask(video: VideoKey, info: VideoInfo, read: () => Promise<SiteResult<OfficialSummary>>): Promise<OfficialRead> {
    const slot = slotOf(video, info);
    const existing = asking.get(slot);
    if (existing) return existing;
    const started = (async () => {
      try {
        return await readOf(await read());
      } catch (error) {
        log.warn("读官方总结失败", errorLabel(error));
        return { record: blank("failed"), cues: [] };
      }
    })();
    asking.set(slot, started);
    void started.then(() => {
      if (asking.get(slot) === started) asking.delete(slot);
    });
    return started;
  }

  function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof EXPIRED> {
    let timer: unknown;
    const expired = new Promise<typeof EXPIRED>((resolve) => {
      timer = timers.setTimeout(() => resolve(EXPIRED), ms);
    });
    return Promise.race([promise, expired]).finally(() => timers.clearTimeout(timer));
  }

  // 先交了字幕的读取：官方总结回来后只填回还是占位的那条，别处已经写了别的就不动。清除之后建的记录不归它管。
  // 这期间导入、移除字幕文件作废了字幕的那条照样填：官方总结不跟字幕走，之后用导入的字幕时不再重问。
  function fillLate(video: VideoKey, info: VideoInfo, pending: Promise<OfficialRead>, since: ClearEpoch | undefined): void {
    const slot = slotOf(video, info);
    const waiting = (current: CachedTranscript | null): boolean =>
      current?.official?.status === "pending" && current.info.mediaVersion === info.mediaVersion;
    const filled = pending.then(async ({ record }) => {
      try {
        await writer.update(video, (current) => (waiting(current) && current ? { ...current, official: record } : null), since);
      } catch (error) {
        log.error("官方总结写回缓存失败", errorLabel(error));
      }
      if (!guard.clearedSince(since, "cache")) patchMemory(video, (remembered) => (waiting(remembered) ? { ...remembered, official: record } : null));
      return record;
    });
    late.set(slot, filled);
    void filled.then(() => {
      if (late.get(slot) === filled) late.delete(slot);
    });
  }

  return {
    forRead(video, cached, { lang, refresh, remembered }, read) {
      return async (info, ctx) => {
        const kept = cached?.official;
        // 附带的字幕不进缓存：兜底可能要用它的时候，沿用缓存就没字幕可用了，得重新问。
        const reusable =
          kept !== undefined &&
          !refresh &&
          cached?.info.mediaVersion === info.mediaVersion &&
          !needsRetry(kept, timers.now()) &&
          (lang !== "" || !captionsFallback || !kept.hasCaptions);
        if (reusable) return { record: kept, cues: [] };
        // 轻量读取记着的连附带的字幕也在，兜底照样用得上。只接同一媒体版本的定论；没定论的这次再问，问到的换给它。
        const light = remembered ? await remembered() : null;
        const same = light !== null && light.mediaVersion === info.mediaVersion;
        // 记着的是从缓存里接过来的那份时没有附带的字幕：兜底要用它的时候同样得重新问。
        const usable = same && (lang !== "" || !captionsFallback || !light.read.record.hasCaptions || light.read.cues.length > 0);
        if (usable && SETTLED_STATUSES.has(light.read.record.status)) return light.read;
        const asked = ask(video, info, () => read(info, ctx));
        if (same) void asked.then(light.replace);
        return asked;
      };
    },

    lookup: ask,

    lateFor(video) {
      for (const [slot, filled] of late) if ((JSON.parse(slot) as [string, string])[0] === video) return filled;
      return undefined;
    },

    async attach(video, record, pending, since) {
      if (!pending) return record;
      const settled = await within(pending, OFFICIAL_GRACE_MS);
      if (settled !== EXPIRED) return { ...record, official: settled.record };
      fillLate(video, record.info, pending, since);
      return { ...record, official: blank("pending") };
    },

    async fallback(video, failure, read, lang, { info, tracks = [], chapters = [] }) {
      if (!captionsFallback || lang || !info || read.cues.length === 0 || !FALLBACK_CODES.has(failure.code)) return null;
      const fingerprint = await transcriptFingerprint(read.cues);
      const transcript = {
        ref: { video, kind: "official-ai" as const, lang: OFFICIAL_CAPTIONS_LANG, fingerprint },
        trackId: OFFICIAL_TRACK_ID,
        label: OFFICIAL_SUBTITLE_LABEL,
        cues: read.cues,
      };
      return recordOf(info, transcript, tracks, chapters, read.record);
    },

    refresh(video, record, read) {
      const kept = record.official;
      if (!kept || !needsRetry(kept, timers.now())) return null;
      const since = guard.epoch();
      const { info } = record;
      // 这期间条目被清掉、换了媒体版本或者已经有了新结论，都不写；字幕被作废了的条目照样写。
      const stillWaiting = (current: CachedTranscript | null): boolean =>
        Boolean(current?.official && needsRetry(current.official, timers.now())) && current?.info.mediaVersion === info.mediaVersion;
      return ask(video, info, () => read(info)).then(async ({ record: fresh }) => {
        try {
          await writer.update(video, (current) => (stillWaiting(current) && current ? { ...current, official: fresh } : null), since);
        } catch (error) {
          log.error("重问的官方总结写回缓存失败", errorLabel(error));
        }
        return fresh;
      });
    },

    async settled(video, record) {
      if (record.official?.status !== "pending") return record;
      const filled = late.get(slotOf(video, record.info));
      return filled ? { ...record, official: await filled } : record;
    },

    forget() {
      asking.clear();
      late.clear();
    },
  };
}
