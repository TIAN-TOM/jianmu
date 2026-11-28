// 站点适配层的契约，后台和内容脚本共用，不带 DOM 类型。
import type { SiteErrorCode, SiteFailureReach } from "../core/errors/site.ts";
import type { OutputLang } from "../core/output-lang.ts";
import type { OutlineSection } from "../core/transcript/outline.ts";
import type { CaptionKind } from "../core/transcript/sources.ts";
import type { TriageItem } from "../core/triage/state.ts";
import type { ChannelRef, Platform, VideoRef } from "../core/video-ref.ts";

export type { CaptionKind, OutlineSection, SiteErrorCode, SiteFailureReach };

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

// 评论区的一条：不带昵称和评论者身份（PRD F23）。
export interface TopComment {
  text: string;
  likes: number;
  pinned: boolean;
}

// 内容格式不对时必须标影响范围，别的码的含义由码本身决定。
export type SiteFailure =
  | { ok: false; code: "MALFORMED"; reach: SiteFailureReach; retryAfterSec?: never; detail?: string; rejected?: true }
  | { ok: false; code: Exclude<SiteErrorCode, "MALFORMED">; retryAfterSec?: number; detail?: string; rejected?: true };

export type SiteResult<T> = { ok: true; value: T } | SiteFailure;

type R<T> = Promise<SiteResult<T>>;

// 这个站的字幕由谁读：service 是后台自己向平台读；page 是用户点了读取才经视频页读，后台不为它自己去读。
export type CaptionAccess = "service" | "page";

// 地址规则是纯函数，后台、页面和内容脚本共用。
export interface SiteRules {
  platform: Platform;
  optionalPermission: boolean; // 这个站的主机权限要不要用户另外授予
  captions: CaptionAccess;
  parseWatchUrl(url: string): VideoRef | null; // 只认首发支持的页面
  canonicalUrl(ref: VideoRef, atSec?: number): string;
  permissionOrigins: readonly string[]; // 启用这个站时请用户授权的来源；安装时就有授权的站是空的
  scriptMatches: readonly string[]; // 启用后动态注册内容脚本用的匹配规则；在清单里静态声明的站是空的
  trackName?(trackId: string, lang: OutputLang, kind?: CaptionKind): string | null; // 字幕轨按界面语言显示的名字；不用换的回 null，照原样显示
}

// 经内容脚本在页面里读的通道：只发给这个标签页顶层框架里的内容脚本，送不到、中止或超时时抛错。
export interface PageChannel {
  ask(message: unknown, signal: AbortSignal): Promise<unknown>;
}

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
  // loginOptional：没登录也读（标题、作者、时长这些公开信息），只给显示和定模式用；别的读取照旧要登录。
  readVideoInfo(ref: VideoRef, ctx: SiteCtx, options?: { loginOptional?: boolean }): R<VideoInfo>;
  listCaptionTracks(info: VideoInfo, ctx: SiteCtx, options?: { fresh?: boolean }): R<CaptionTrack[]>; // 用户刷新和换语言时带 fresh
  readCaptions(info: VideoInfo, track: CaptionTrack, ctx: SiteCtx): R<Cue[]>;
  readOfficialSummary?(info: VideoInfo, ctx: SiteCtx): R<OfficialSummary>;
  readCreatorChapters?(info: VideoInfo, ctx: SiteCtx, options?: { fresh?: boolean }): R<Chapter[]>; // 和列轨一起带 fresh，分段跟着新的列表走
  readWatchLater?(ctx: SiteCtx): R<WatchLaterList>;
  readTopComments?(info: VideoInfo, ctx: SiteCtx): R<TopComment[]>; // 第一批热评，置顶的排前面；只在生成概览时调（PRD F23）
  // 字幕要用户点了读取才读的站：只看页面上已经有的，不点、不发请求、不动播放器。确定这个视频没有字幕时是 true，有字幕或判断不了都是 false。
  knownNoCaptions?(ref: VideoRef, ctx: SiteCtx): Promise<boolean>;
}
