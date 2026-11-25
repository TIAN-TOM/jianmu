// 卡片的轻量读取：卡片摆的是官方总结、本机已有的概览和结论，用不着字幕正文。字幕已经缓存时照常用缓存；
// 没缓存时问视频信息和官方总结；卡片自己来读、又登录着时再列一次字幕轨，只看有没有：不读字幕文件，也不新建缓存条目。
// 后台为「打开就出结论」问时长也走这里，那时不列：被跳过的短视频不多发一次请求。
// 列表空着、官方总结也不会附带字幕兜底，才告诉卡片没有字幕，不摆「生成概览」；列不成、拿不准时照旧摆。
// 问到的只记在内存里（最近 10 个），同一个视频再读不再问、不再列；用户随后完整读取时，有定论的官方总结（连同附带的字幕）
// 也接着用，列到的字幕轨读取实现自己记着，不再列一次。
// 同一个视频的完整读取已经在路上就并进去，最多等 4 秒；等不到就用它已经读到的视频信息和官方总结，不再多问一遍。
// 字幕要用户点了读取才读的站（YouTube）只看本机，也不并进完整读取；本机没有字幕时，再问一句卡片所在的页面：
// 播放器上已有的字幕轨列表确定是空的，才告诉卡片没有字幕。不点、不发请求、不动播放器。
import type { ClearGuard } from "../../../core/clear-guard.ts";
import { fail, ok, type Failure } from "../../../core/errors.ts";
import { videoKey, type Platform, type VideoKey, type VideoRef } from "../../../core/video-ref.ts";
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
import type { SiteCtx, SiteService, VideoInfo } from "../../../sites/types.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import { overviewView } from "../overview/view.ts";
import type { Timers } from "../../tasks.ts";
import { needsRetry, settledWithoutCaptions, type OfficialRead, type Officials, type RememberedOfficial } from "./official.ts";
import type { SiteAccess } from "./read.ts";
import { failureOf } from "./tracks.ts";
import { hasTranscript, infoView, officialView, type TranscriptCache, type TranscriptRecord } from "./write.ts";

export const LIGHT_MEMO_LIMIT = 10;
/** 卡片并进完整读取时最多等这么久：字幕文件卡住时完整读取要很久，卡片用不着字幕。 */
export const LIGHT_JOIN_MS = 4_000;

// 读不到字幕的这两种情况告诉卡片；被限流、超时这些过一阵再试可能就好了，不说成没有字幕。
const UNAVAILABLE: ReadonlySet<string> = new Set<TranscriptUnavailable>(["NO_CAPTIONS", "NEED_LOGIN"]);

// 字幕和视频信息都只能经页面读、而且要用户点了读取才读的站：卡片不为自己去读。
const LOCAL_ONLY: ReadonlySet<Platform> = new Set<Platform>(["youtube"]);
// 本机连视频信息都没有时给卡片的：卡片不写标题，也不按它定模式。
const NO_INFO: VideoInfoView = { title: "", author: "", description: "", durationSec: 0 };

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
  /** 官方总结附带的 AI 字幕兜底开着没有：开着时，列表空着还要看官方总结会不会附带字幕。 */
  readonly captionsFallback: boolean;
  readonly joinable: (video: VideoKey) => JoinableRead | undefined;
  /** 命中字幕缓存时的回复：过了重问时间的官方总结在后台重问，占位要等。 */
  readonly fromCache: (ref: VideoRef, video: VideoKey, cached: TranscriptRecord) => Promise<TranscriptReply>;
  /** 只看本机的读取：缓存、内存和导入的文件，没有时回 NOT_CACHED，不向平台和页面发任何请求。 */
  readonly local: (ref: VideoRef) => Promise<TranscriptReply>;
  /** 这个视频导入的字幕文件的指纹，没有导入时是 null：没点名语言的读取先用它，它就是现在用的字幕。 */
  readonly importedFingerprint: (video: VideoKey) => Promise<string | null>;
}

export interface Light {
  /** tabId 是卡片所在的标签页，只有卡片来读时才有：只看本机的站没字幕时问这一页，别的站有它才列字幕轨。 */
  read(ref: VideoRef, video: VideoKey, tabId?: number): Promise<GuidesReply>;
  /** 给完整读取接着用：还在读的等它读完，交回记着的官方总结；没有时是 null。 */
  remembered(video: VideoKey): Promise<RememberedOfficial | null>;
  /** 记着的视频时长：还在读的等它读完，不另发请求；不知道时是 null。 */
  durationOf(video: VideoKey): Promise<number | null>;
  /** 这个视频的缓存或字幕变了：记着的不再用。 */
  drop(video: VideoKey): void;
  /** 清除本机数据时：记着的全忘掉，在途的回来也不记。 */
  forget(): void;
}

/** 列字幕轨看到的：none 列表是空的，some 有字幕轨。 */
type Listed = "none" | "some";

interface Memo {
  readonly info: VideoInfo;
  readonly official?: OfficialRead | undefined;
  /** 没列、列不成时没有。 */
  readonly tracks?: Listed | undefined;
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
  // forCard：这次读取会不会列字幕轨。后台的读取在路上时卡片并进去以后还要补列一次。
  const requests = new Map<VideoKey, { readonly reply: Promise<GuidesReply>; readonly forCard: boolean }>();
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

  async function importedOf(video: VideoKey): Promise<string | null> {
    try {
      return await deps.importedFingerprint(video);
    } catch (error) {
      log.warn("读导入的字幕失败", errorLabel(error));
      return null;
    }
  }

  // 只给生效中的那份：重新生成写到一半的草稿不摆到卡片上。
  async function overviewOf(video: VideoKey): Promise<OverviewView | undefined> {
    try {
      return overviewView(await deps.overviews.find(video));
    } catch (error) {
      log.warn("读本机概览失败", errorLabel(error));
      return undefined;
    }
  }

  async function success(
    video: VideoKey,
    info: VideoInfoView,
    official: OfficialSummaryView | undefined,
    marks: { readonly hasTranscript: boolean; readonly fromCache: boolean; readonly transcriptFingerprint?: string; readonly transcriptError?: TranscriptUnavailable },
  ): Promise<GuidesReply> {
    const overview = await overviewOf(video);
    // 刚导入、缓存里的字幕作废了还没重读时，也认得出现在用的是导入的那份。
    const transcriptFingerprint = (await importedOf(video)) ?? marks.transcriptFingerprint;
    const view: GuidesView = {
      mode: "light",
      video,
      info,
      ...(official ? { official } : {}),
      ...(overview ? { overview } : {}),
      hasTranscript: marks.hasTranscript,
      fromCache: marks.fromCache,
      ...(transcriptFingerprint ? { transcriptFingerprint } : {}),
      ...(marks.transcriptError ? { transcriptError: marks.transcriptError } : {}),
    };
    return ok(view);
  }

  async function failure(video: VideoKey, failed: Failure): Promise<GuidesFailure> {
    const overview = await overviewOf(video);
    return { ...bareFailure(failed), ...(overview ? { overview } : {}) };
  }

  // 并进的完整读取读到了字幕：官方总结还是占位（字幕先交了）就等它回来，不说成没有官方总结。
  // 只等这次读取自己那个媒体版本的：刷新时换了新版本，旧版本迟到的官方总结不能和新的视频信息摆在一起。
  // 不知道这次读取用的是哪个版本（没向平台读）时不等，照实摆占位。
  async function fromView(video: VideoKey, view: TranscriptView, reading: ReadingGuides | undefined): Promise<GuidesReply> {
    let official = view.official;
    if (official?.status === "pending" && reading) {
      const filled = deps.officials.lateFor(video, reading.info);
      if (filled) official = officialView(await filled);
    }
    return success(video, view.info, official, { hasTranscript: true, fromCache: view.fromCache, transcriptFingerprint: view.transcript.ref.fingerprint });
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
    if (reply !== EXPIRED) return reply.ok ? fromView(video, reply.value, reading) : fromFailure(video, reply, reading);
    // 视频信息都还没读到：自己读。
    if (!reading) return null;
    const official = reading.official ? (await reading.official).record : undefined;
    return success(video, infoView(reading.info), official ? officialView(official) : undefined, { hasTranscript: false, fromCache: false });
  }

  // 问卡片所在的页面这个视频是不是确定没有字幕。没有标签页、站点没这项能力、问不成都当判断不了。
  async function noCaptionsOnPage(ref: VideoRef, tabId: number | undefined): Promise<boolean> {
    const site = deps.sites.service(ref.platform);
    if (tabId === undefined || !site?.knownNoCaptions) return false;
    try {
      return (await site.knownNoCaptions(ref, deps.sites.ctx(ref.platform, { signal: new AbortController().signal, tabId }))) === true;
    } catch (error) {
      log.warn("问页面有没有字幕失败", errorLabel(error));
      return false;
    }
  }

  // 本机有字幕（读过、导入过）就照常摆，能生成概览；没有就告诉卡片先在侧边栏读，页面确定没有字幕时告诉卡片没有字幕。
  // 视频信息只用缓存里记着的。
  async function localOnly(ref: VideoRef, video: VideoKey, tabId: number | undefined): Promise<GuidesReply> {
    const reply = await deps.local(ref);
    if (reply.ok) return success(video, reply.value.info, undefined, { hasTranscript: true, fromCache: reply.value.fromCache, transcriptFingerprint: reply.value.transcript.ref.fingerprint });
    if (reply.code !== "NOT_CACHED") return failure(video, reply);
    const cached = await cache.load(video);
    const transcriptError = (await noCaptionsOnPage(ref, tabId)) ? "NO_CAPTIONS" : "NOT_CACHED";
    return success(video, cached ? infoView(cached.info) : NO_INFO, undefined, { hasTranscript: false, fromCache: false, transcriptError });
  }

  // 只看列表空不空，列不成（被限流、网络、超时、格式不对、要登录）都不下结论。
  async function listedOf(site: SiteService, info: VideoInfo, ctx: SiteCtx): Promise<Listed | undefined> {
    try {
      const listed = await site.listCaptionTracks(info, ctx);
      if (!listed.ok) return undefined;
      return listed.value.length === 0 ? "none" : "some";
    } catch (error) {
      log.warn("卡片列字幕轨失败", errorLabel(error));
      return undefined;
    }
  }

  async function load(ref: VideoRef, video: VideoKey, forCard: boolean): Promise<GuidesReply> {
    const since = guard.epoch();
    const started = epoch;
    const cached = await cache.load(video);
    if (hasTranscript(cached)) {
      const reply = await deps.fromCache(ref, video, cached);
      return reply.ok
        ? success(video, reply.value.info, reply.value.official, { hasTranscript: true, fromCache: true, transcriptFingerprint: reply.value.transcript.ref.fingerprint })
        : failure(video, reply);
    }
    // 缓存里没有字幕但还有视频信息和官方总结（字幕被作废了）：一样接着用。
    const known: Memo | undefined =
      memo.get(video) ?? (cached ? { info: cached.info, official: cached.official ? { record: cached.official, cues: [] } : undefined } : undefined);
    const site = deps.sites.service(ref.platform);
    // 读取环境用到时才建，视频信息和官方总结共用一个。视频信息没登录也读，官方总结要登录。
    let ctx: SiteCtx | undefined;
    const ctxOf = (): SiteCtx => (ctx ??= deps.sites.ctx(ref.platform, { signal: new AbortController().signal }));
    let info = known?.info;
    if (!info) {
      if (!site) return failure(video, fail("SITE_UNSUPPORTED"));
      const read = await site.readVideoInfo(ref, ctxOf(), { loginOptional: true });
      if (!read.ok) return failure(video, failureOf(read));
      if (!sameVideo(read.value, video)) return failure(video, fail("MALFORMED", "video-mismatch"));
      info = read.value;
    }
    const asking = info;
    let official = known?.official;
    const ask = site?.readOfficialSummary?.bind(site);
    // 要登录的每次都重问：登录以后卡片马上就能读到，不等重问间隔。
    if (ask && (!official || official.record.status === "need-login" || needsRetry(official.record, timers.now()))) {
      official = await deps.officials.lookup(video, asking, () => ask(asking, ctxOf()));
    }
    const needLogin = official?.record.status === "need-login";
    // 登录着的列一次字幕轨，和视频信息、官方总结共用读取环境。缓存里还有这个视频的记录（字幕被作废了）就不列：
    // 读过的视频照旧不发请求，记过的字幕轨也说明它有字幕。导入了字幕文件的也不列：生成用的就是它。
    let tracks = known?.tracks;
    if (forCard && !tracks && !cached && site && !needLogin && (await importedOf(video)) === null) tracks = await listedOf(site, asking, ctxOf());
    if (!guard.clearedSince(since, "cache") && started === epoch) remember(video, { info, official, tracks });
    // 列表空着，官方总结也不会附带字幕兜底：完整读取同样读不到字幕。
    const noCaptions = tracks === "none" && (!deps.captionsFallback || !official || settledWithoutCaptions(official));
    // 官方总结说要登录：没登录，字幕也读不到，告诉卡片，不摆「生成概览」。
    const transcriptError = needLogin ? "NEED_LOGIN" : noCaptions ? "NO_CAPTIONS" : undefined;
    return success(video, infoView(info), official ? officialView(official.record) : undefined, { hasTranscript: false, fromCache: false, ...(transcriptError ? { transcriptError } : {}) });
  }

  return {
    async read(ref, video, tabId) {
      if (LOCAL_ONLY.has(ref.platform)) return localOnly(ref, video, tabId);
      const forCard = tabId !== undefined;
      // 已经有轻量读取在路上就并进它；没有时看完整读取。
      if (!requests.has(video)) {
        const full = deps.joinable(video);
        const joined = full ? await join(video, full) : null;
        if (joined) return joined;
      }
      let pending = requests.get(video);
      // 在路上的是后台那种不列字幕轨的：等它读完，再从记着的接着读一次，只补列字幕轨。
      if (pending && forCard && !pending.forCard) {
        await pending.reply.catch(() => null);
        pending = requests.get(video);
      }
      if (!pending) {
        const created = { reply: load(ref, video, forCard), forCard };
        pending = created;
        requests.set(video, created);
        const settled = (): void => {
          if (requests.get(video) === created) requests.delete(video);
        };
        created.reply.then(settled, settled);
      }
      const reply = await pending.reply;
      return reply.ok ? { ok: true, value: { ...reply.value } } : { ...reply };
    },

    async remembered(video) {
      const pending = requests.get(video);
      if (pending) await pending.reply.catch(() => null);
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

    async durationOf(video) {
      const pending = requests.get(video);
      if (pending) await pending.reply.catch(() => null);
      const seconds = memo.get(video)?.info.durationSec;
      return typeof seconds === "number" && seconds > 0 ? seconds : null;
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
