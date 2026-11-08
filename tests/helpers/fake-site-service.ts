// 站点读取服务的替身：后台各服务的测试用它，不碰真实的读取实现和请求。每次调用都记下来（含读取环境），
// 各能力按测试给的脚本回，没给时回一份自造的样例。失败只给错误码和影响范围，不给平台的细节说明。
import type { VideoRef } from "../../src/core/video-ref.ts";
import type {
  CaptionTrack,
  Chapter,
  Cue,
  OfficialSummary,
  SiteCtx,
  SiteFailure,
  SiteResult,
  SiteRules,
  SiteService,
  VideoInfo,
  WatchLaterList,
} from "../../src/sites/types.ts";

export type SiteMethod = "readVideoInfo" | "listCaptionTracks" | "readCaptions" | "readOfficialSummary" | "readCreatorChapters" | "readWatchLater";

export interface SiteCall {
  readonly method: SiteMethod;
  readonly ctx: SiteCtx;
  readonly ref?: VideoRef;
  readonly info?: VideoInfo;
  readonly track?: CaptionTrack;
  readonly options?: { readonly fresh?: boolean } | undefined;
}

type Reply<T> = SiteResult<T> | Promise<SiteResult<T>>;

/** 每种能力怎么回。改这里的函数就换了脚本，已经发出的调用不受影响。 */
export interface SiteScript {
  videoInfo: (ref: VideoRef, ctx: SiteCtx) => Reply<VideoInfo>;
  tracks: (info: VideoInfo, ctx: SiteCtx, options?: { readonly fresh?: boolean }) => Reply<CaptionTrack[]>;
  captions: (info: VideoInfo, track: CaptionTrack, ctx: SiteCtx) => Reply<Cue[]>;
  chapters: (info: VideoInfo, ctx: SiteCtx) => Reply<Chapter[]>;
  officialSummary: (info: VideoInfo, ctx: SiteCtx) => Reply<OfficialSummary>;
  watchLater: (ctx: SiteCtx) => Reply<WatchLaterList>;
}

export interface FakeSiteService {
  readonly service: Required<SiteService>;
  readonly calls: SiteCall[];
  readonly script: SiteScript;
  count(method: SiteMethod): number;
}

/** 自造的视频号，和 B 站读取测试的样例同一个。 */
export const SAMPLE_ID = "BV1Sample000";

export const ZH: CaptionTrack = { trackId: "zh-CN", lang: "zh-CN", label: "中文（中国）", kind: "human" };
export const EN: CaptionTrack = { trackId: "en-US", lang: "en-US", label: "英语", kind: "human" };

/** 自造的视频信息：媒体版本按视频和分 P 现编，不同视频、不同分 P 各不相同。 */
export function sampleInfo(ref: VideoRef, overrides: Partial<VideoInfo> = {}): VideoInfo {
  const segment = ref.segment ?? 1;
  return {
    ref,
    title: `样例视频 ${ref.videoId} 第 ${segment} P`,
    author: "样例作者",
    channel: { platform: ref.platform, channelId: "3003" },
    description: "样例简介",
    durationSec: 120,
    mediaVersion: `${ref.videoId}-m${segment}`,
    segments: [{ index: segment, title: `第 ${segment} P`, durationSec: 120 }],
    ...overrides,
  };
}

export function sampleCues(lang: string): Cue[] {
  return lang.startsWith("en")
    ? [
        { start: 0, duration: 2, text: "First line" },
        { start: 2, duration: 2, text: "Second line" },
      ]
    : [
        { start: 0, duration: 2, text: "第一句" },
        { start: 2, duration: 2, text: "第二句" },
      ];
}

export const failed = (code: SiteFailure["code"], extra: Partial<Omit<SiteFailure, "ok" | "code">> = {}): SiteFailure =>
  (code === "MALFORMED" ? { ok: false, code, reach: "item", ...extra } : { ok: false, code, ...extra }) as SiteFailure;

const rules: SiteRules = {
  platform: "bilibili",
  optionalPermission: false,
  parseWatchUrl: () => null,
  canonicalUrl: (ref) => `https://watch.example/watch/${ref.videoId}`,
};

/** 一直不回，直到这次读取的环境被中止，回读取实现中止时的那种失败。 */
export function untilAborted<T>(ctx: SiteCtx): Promise<SiteResult<T>> {
  return new Promise((resolve) => {
    const done = () => resolve({ ok: false, code: "NETWORK", detail: "aborted" });
    if (ctx.signal.aborted) done();
    else ctx.signal.addEventListener("abort", done, { once: true });
  });
}

export function fakeSiteService(overrides: Partial<SiteScript> = {}): FakeSiteService {
  const calls: SiteCall[] = [];
  const script: SiteScript = {
    videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref) }),
    tracks: () => ({ ok: true, value: [ZH, EN] }),
    captions: (_info, track) => ({ ok: true, value: sampleCues(track.lang) }),
    chapters: () => ({ ok: true, value: [] }),
    officialSummary: () => ({ ok: true, value: { status: "none", summary: "", outline: [], cues: [] } }),
    watchLater: () => ({ ok: true, value: { total: 0, dropped: 0, items: [] } }),
    ...overrides,
  };
  const record = (call: SiteCall): void => void calls.push(call);
  const service: Required<SiteService> = {
    rules,
    async readVideoInfo(ref, ctx) {
      record({ method: "readVideoInfo", ctx, ref });
      return script.videoInfo(ref, ctx);
    },
    async listCaptionTracks(info, ctx, options) {
      record({ method: "listCaptionTracks", ctx, info, options });
      return script.tracks(info, ctx, options);
    },
    async readCaptions(info, track, ctx) {
      record({ method: "readCaptions", ctx, info, track });
      return script.captions(info, track, ctx);
    },
    async readOfficialSummary(info, ctx) {
      record({ method: "readOfficialSummary", ctx, info });
      return script.officialSummary(info, ctx);
    },
    async readCreatorChapters(info, ctx) {
      record({ method: "readCreatorChapters", ctx, info });
      return script.chapters(info, ctx);
    },
    async readWatchLater(ctx) {
      record({ method: "readWatchLater", ctx });
      return script.watchLater(ctx);
    },
  };
  return { service, calls, script, count: (method) => calls.filter((call) => call.method === method).length };
}
