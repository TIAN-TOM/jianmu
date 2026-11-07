// 站点适配层的契约，后台和内容脚本共用，不带 DOM 类型。
import type { CaptionKind } from "../core/transcript/sources.ts";
import type { TriageItem } from "../core/triage/state.ts";
import type { ChannelRef, Platform, VideoRef } from "../core/video-ref.ts";

export type { CaptionKind };

export interface CaptionTrack {
  trackId: string;
  lang: string;
  label: string;
  kind: CaptionKind;
  isOriginalLang?: boolean; // 有可靠依据时才标，只有一种人工字幕语言不算依据
}

// 时间都按秒算。
export interface Cue {
  start: number;
  duration: number;
  text: string;
}

export interface VideoInfo {
  ref: VideoRef;
  title: string;
  author: string;
  channel?: ChannelRef;
  description: string;
  durationSec: number;
  audioLang?: string; // 读不到时不填，不猜
  mediaVersion?: string; // 不进身份键；B 站读字幕和官方总结要用，变了时提示这一 P 可能换过内容
  siteRef?: string; // 适配器自用的不透明串，别处不解析
  segments?: { index: number; title: string; durationSec: number }[];
}

export interface Chapter {
  title: string;
  start: number;
  end: number | null;
}

// 字段和 core 已读的、用户备份里已有的形状一致。
export interface OutlineSection {
  title: string;
  timestamp: number | null;
  points: { timestamp: number | null; content: string }[];
}

export interface OfficialSummary {
  status: "ok" | "none" | "queued" | "unsupported";
  summary: string;
  outline: OutlineSection[];
  cues: Cue[];
}

export interface WatchLaterItem extends TriageItem {
  cover: string;
  description: string;
  addedAt: number;
  paidChecked: boolean; // 确认了付费或免费才是真；为假时读官方总结前要先读视频信息
}

export interface WatchLaterList {
  total: number;
  dropped: number;
  items: WatchLaterItem[];
}

export type SiteErrorCode =
  | "NEED_LOGIN"
  | "NO_CAPTIONS"
  | "EMPTY_CAPTION_FILE"
  | "RATE_LIMITED"
  | "UNPLAYABLE"
  | "NOT_FOUND"
  | "SEGMENT_OUT_OF_RANGE"
  | "VIDEO_CHANGED"
  | "TAB_NOT_READY"
  | "MALFORMED"
  | "NETWORK"
  | "TIMEOUT";

export type SiteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SiteErrorCode; retryAfterSec?: number; detail?: string };

type R<T> = Promise<SiteResult<T>>;

// 地址规则是纯函数，后台、页面和内容脚本共用。
export interface SiteRules {
  platform: Platform;
  optionalPermission: boolean; // 这个站的主机权限要不要用户另外授予
  parseWatchUrl(url: string): VideoRef | null; // 只认首发支持的页面
  canonicalUrl(ref: VideoRef, atSec?: number): string;
}

// 经内容脚本在页面里读的通道，这里只占位。
export interface PageChannel {}

// 实现在平台层，平台层不导入站点层，形状相同就行。
export interface SiteBackoff {
  admit(signal: AbortSignal): Promise<{ ok: true } | { ok: false; retryAfterSec: number }>; // 退避期内不放行，平时按站点限速
  trip(retryAfterSec?: number): Promise<void>; // 被限流时进退避
  clear(): Promise<void>; // 读取成功后清掉连续命中次数
}

// 一次读取操作用一个，不跨操作复用：站点可以把只在这次操作里成立的结论记在它上面。
export interface SiteCtx {
  fetch: typeof fetch; // 由调用方注入，测试换成替身
  signal: AbortSignal;
  page?: PageChannel; // 需要在页面里读时，经该标签页的内容脚本转发
  backoff: SiteBackoff; // 按站点的限流退避，跨标签页共享
}

// 在后台跑。带问号的是站点专属能力，调用方没有就不显示那一块。
export interface SiteService {
  rules: SiteRules;
  readVideoInfo(ref: VideoRef, ctx: SiteCtx): R<VideoInfo>;
  listCaptionTracks(info: VideoInfo, ctx: SiteCtx, options?: { fresh?: boolean }): R<CaptionTrack[]>; // 用户刷新和换语言时带 fresh
  readCaptions(info: VideoInfo, track: CaptionTrack, ctx: SiteCtx): R<Cue[]>;
  readOfficialSummary?(info: VideoInfo, ctx: SiteCtx): R<OfficialSummary>;
  readCreatorChapters?(info: VideoInfo, ctx: SiteCtx): R<Chapter[]>;
  readWatchLater?(ctx: SiteCtx): R<WatchLaterList>;
}
