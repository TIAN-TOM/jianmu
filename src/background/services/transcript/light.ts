// 卡片的轻量读取：卡片摆的是官方总结、本机已有的概览和结论，用不着字幕。字幕已经缓存时照常用缓存；
// 没缓存时只问视频信息和官方总结，不列轨、不读字幕文件，也不新建缓存条目。问到的只记在内存里（最近 10 个），
// 同一个视频再读不再问；用户随后完整读取时，有定论的官方总结（连同附带的字幕）也接着用。
// 同一个视频的完整读取已经在路上就并进去，最多等 4 秒；等不到就用它已经读到的视频信息和官方总结，不再多问一遍。
import type { ClearGuard } from "../../../core/clear-guard.ts";
import { fail, ok, type Failure } from "../../../core/errors.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../../core/video-ref.ts";
import type {
  GuidesFailure,
  GuidesReply,
  GuidesView,
  OfficialSummaryView,
  OverviewView,
  TranscriptFailure,
  TranscriptReply,
  TranscriptUnavailable,
  TranscriptView,
  VideoInfoView,
} from "../../../shared/messages/transcript.ts";
import type { SiteCtx, VideoInfo } from "../../../sites/types.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { Timers } from "../../tasks.ts";
import { needsRetry, type OfficialRead, type Officials, type RememberedOfficial } from "./official.ts";
import type { SiteAccess } from "./read.ts";
import { failureOf } from "./tracks.ts";
import { hasTranscript, infoView, officialView, type TranscriptCache, type TranscriptRecord } from "./write.ts";

export const LIGHT_MEMO_LIMIT = 10;
/** 卡片并进完整读取时最多等这么久：字幕文件卡住时完整读取要很久，卡片用不着字幕。 */
export const LIGHT_JOIN_MS = 4_000;

// 读不到字幕的这两种情况告诉卡片；被限流、超时这些过一阵再试可能就好了，不说成没有字幕。
const UNAVAILABLE: ReadonlySet<string> = new Set<TranscriptUnavailable>(["NO_CAPTIONS", "NEED_LOGIN"]);

/** 在途的完整读取已经读到的：核对过的视频信息和它问出去的官方总结。 */
export interface ReadingGuides {
  readonly info: VideoInfo;
  readonly official?: Promise<OfficialRead> | undefined;
}

/** 同一个视频没点名语言的完整读取：它的回复，和读到视频信息以后登记的东西。 */
export interface JoinableRead {
  readonly reply: Promise<TranscriptReply>;
  readonly reading: () => ReadingGuides | undefined;
}

export interface LightDeps {
  readonly sites: SiteAccess;
  readonly cache: TranscriptCache;
  readonly overviews: Pick<OverviewStore, "find">;
  readonly officials: Officials;
  readonly guard: ClearGuard;
  readonly timers: Pick<Timers, "now" | "setTimeout" | "clearTimeout">;
  readonly log: Log;
  readonly joinable: (video: VideoKey) => JoinableRead | undefined;
  /** 命中字幕缓存时的回复：过了重问时间的官方总结在后台重问，占位要等。 */
  readonly fromCache: (ref: VideoRef, video: VideoKey, cached: TranscriptRecord) => Promise<TranscriptReply>;
}

export interface Light {
  read(ref: VideoRef, video: VideoKey): Promise<GuidesReply>;
  /** 给完整读取接着用：还在读的等它读完，交回记着的官方总结；没有时是 null。 */
  remembered(video: VideoKey): Promise<RememberedOfficial | null>;
  /** 这个视频的缓存或字幕变了：记着的不再用。 */
  drop(video: VideoKey): void;
  /** 清除本机数据时：记着的全忘掉，在途的回来也不记。 */
  forget(): void;
}

interface Memo {
  readonly info: VideoInfo;
  readonly official?: OfficialRead | undefined;
}

const EXPIRED = Symbol("expired");

function sameVideo(info: VideoInfo, video: VideoKey): boolean {
  try {
    return videoKey(info.ref) === video;
  } catch {
    return false;
  }
}

/** 只带失败本身的几样，不带完整读取的字幕轨和分段。 */
function bareFailure({ code, detail, retryAfterSec }: Failure): Failure {
  return { ok: false, code, ...(detail === undefined ? {} : { detail }), ...(retryAfterSec === undefined ? {} : { retryAfterSec }) };
}

export function createLight(deps: LightDeps): Light {
  const { cache, guard, timers, log } = deps;
  const memo = new Map<VideoKey, Memo>();
  const requests = new Map<VideoKey, Promise<GuidesReply>>();
  // 清除本机数据时加一：在这之前开始的读取回来时不再记。
  let epoch = 0;

  function remember(video: VideoKey, entry: Memo): void {
    memo.delete(video);
    memo.set(video, entry);
    while (memo.size > LIGHT_MEMO_LIMIT) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }

  async function overviewOf(video: VideoKey): Promise<OverviewView | undefined> {
    try {
      const record = await deps.overviews.find(video);
      return record ? { analysis: record.analysis, analysisFailures: record.analysisFailures ?? [] } : undefined;
    } catch (error) {
      log.warn("读本机概览失败", errorLabel(error));
      return undefined;
    }
  }

  async function success(
    video: VideoKey,
    info: VideoInfoView,
    official: OfficialSummaryView | undefined,
    marks: { readonly hasTranscript: boolean; readonly fromCache: boolean; readonly transcriptError?: TranscriptUnavailable },
  ): Promise<GuidesReply> {
    const overview = await overviewOf(video);
    const view: GuidesView = {
      mode: "light",
      video,
      info,
      ...(official ? { official } : {}),
      ...(overview ? { overview } : {}),
      hasTranscript: marks.hasTranscript,
      fromCache: marks.fromCache,
      ...(marks.transcriptError ? { transcriptError: marks.transcriptError } : {}),
    };
    return ok(view);
  }

  async function failure(video: VideoKey, failed: Failure): Promise<GuidesFailure> {
    const overview = await overviewOf(video);
    return { ...bareFailure(failed), ...(overview ? { overview } : {}) };
  }

  // 并进的完整读取读到了字幕：官方总结还是占位（字幕先交了）就等它回来，不说成没有官方总结。
  async function fromView(video: VideoKey, view: TranscriptView): Promise<GuidesReply> {
    let official = view.official;
    if (official?.status === "pending") {
      const filled = deps.officials.lateFor(video);
      if (filled) official = officialView(await filled);
    }
    return success(video, view.info, official, { hasTranscript: true, fromCache: view.fromCache });
  }

  // 并进的完整读取没读到字幕：读到了视频信息就照样给卡片摆官方总结；视频信息都没读到时如实报错，不再单独问一遍。
  async function fromFailure(video: VideoKey, failed: TranscriptFailure, reading: ReadingGuides | undefined): Promise<GuidesReply> {
    if (!reading) return failure(video, failed);
    const official = failed.official ?? (reading.official ? officialView((await reading.official).record) : undefined);
    const transcriptError = UNAVAILABLE.has(failed.code) ? (failed.code as TranscriptUnavailable) : undefined;
    return success(video, infoView(reading.info), official, { hasTranscript: false, fromCache: false, ...(transcriptError ? { transcriptError } : {}) });
  }

  async function join(video: VideoKey, full: JoinableRead): Promise<GuidesReply | null> {
    let timer: unknown;
    const expired = new Promise<typeof EXPIRED>((resolve) => {
      timer = timers.setTimeout(() => resolve(EXPIRED), LIGHT_JOIN_MS);
    });
    const reply = await Promise.race([full.reply, expired]).finally(() => timers.clearTimeout(timer));
    const reading = full.reading();
    if (reply !== EXPIRED) return reply.ok ? fromView(video, reply.value) : fromFailure(video, reply, reading);
    // 视频信息都还没读到：自己读。
    if (!reading) return null;
    const official = reading.official ? (await reading.official).record : undefined;
    return success(video, infoView(reading.info), official ? officialView(official) : undefined, { hasTranscript: false, fromCache: false });
  }

  async function load(ref: VideoRef, video: VideoKey): Promise<GuidesReply> {
    const since = guard.epoch();
    const started = epoch;
    const cached = await cache.load(video);
    if (hasTranscript(cached)) {
      const reply = await deps.fromCache(ref, video, cached);
      return reply.ok ? success(video, reply.value.info, reply.value.official, { hasTranscript: true, fromCache: true }) : failure(video, reply);
    }
    // 缓存里没有字幕但还有视频信息和官方总结（字幕被作废了）：一样接着用。
    const known: Memo | undefined =
      memo.get(video) ?? (cached ? { info: cached.info, official: cached.official ? { record: cached.official, cues: [] } : undefined } : undefined);
    const site = deps.sites.service(ref.platform);
    // 读取环境用到时才建，视频信息和官方总结共用一个：已登录的结论接着用。
    let ctx: SiteCtx | undefined;
    const ctxOf = (): SiteCtx => (ctx ??= deps.sites.ctx(ref.platform, { signal: new AbortController().signal }));
    let info = known?.info;
    if (!info) {
      if (!site) return failure(video, fail("SITE_UNSUPPORTED"));
      const read = await site.readVideoInfo(ref, ctxOf());
      if (!read.ok) return failure(video, failureOf(read));
      if (!sameVideo(read.value, video)) return failure(video, fail("MALFORMED", "video-mismatch"));
      info = read.value;
    }
    const asking = info;
    let official = known?.official;
    const ask = site?.readOfficialSummary?.bind(site);
    if (ask && (!official || needsRetry(official.record, timers.now()))) {
      official = await deps.officials.lookup(video, asking, () => ask(asking, ctxOf()));
    }
    if (!guard.clearedSince(since, "cache") && started === epoch) remember(video, { info, official });
    return success(video, infoView(info), official ? officialView(official.record) : undefined, { hasTranscript: false, fromCache: false });
  }

  return {
    async read(ref, video) {
      // 已经有轻量读取在路上就并进它；没有时看完整读取。
      if (!requests.has(video)) {
        const full = deps.joinable(video);
        const joined = full ? await join(video, full) : null;
        if (joined) return joined;
      }
      let pending = requests.get(video);
      if (!pending) {
        const created = load(ref, video);
        pending = created;
        requests.set(video, created);
        const settled = (): void => {
          if (requests.get(video) === created) requests.delete(video);
        };
        created.then(settled, settled);
      }
      const reply = await pending;
      return reply.ok ? { ok: true, value: { ...reply.value } } : { ...reply };
    },

    async remembered(video) {
      const pending = requests.get(video);
      if (pending) await pending.catch(() => null);
      const entry = memo.get(video);
      if (!entry?.official) return null;
      return {
        mediaVersion: entry.info.mediaVersion,
        read: entry.official,
        // 只换还是同一份记录时的：这期间又记了新的，或者已经删掉了，都不动。
        replace(fresh) {
          if (memo.get(video) === entry) memo.set(video, { ...entry, official: fresh });
        },
      };
    },

    drop(video) {
      memo.delete(video);
      requests.delete(video);
    },

    forget() {
      epoch += 1;
      memo.clear();
      requests.clear();
    },
  };
}
