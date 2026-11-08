// 取字幕和查原视频还在不在这两条消息的请求和回复。回复里只有页面要显示的东西，不带字幕文件地址和平台的内部编号。
import type { FailureRange } from "../../core/ai/chunking.ts";
import type { Failure } from "../../core/errors.ts";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import type { TranscriptRef } from "../../core/notes/records.ts";
import type { TranscriptSegment } from "../../core/transcript/segment.ts";
import type { CaptionKind } from "../../core/transcript/sources.ts";
import type { ChannelRef, VideoKey } from "../../core/video-ref.ts";

/**
 * full：缓存没有就去平台读；cache-only：只看本机，没有就回没缓存，一个请求都不发；
 * light：卡片用的轻量读取，只要视频信息、官方总结和本机已有的概览，不读字幕。卡片只能用这一种。
 */
export type TranscriptReadMode = "full" | "cache-only" | "light";

export interface TranscriptGetRequest {
  readonly video: VideoKey;
  readonly mode: TranscriptReadMode;
  /** 点名要哪种语言的字幕轨；不点名时按选轨顺序挑。 */
  readonly lang?: string;
  /** 用户点了刷新：不看缓存，重新列轨。 */
  readonly fresh?: boolean;
  /** 视频所在的标签页：没读到视频信息时拿它的标题显示。 */
  readonly tabId?: number;
}

export interface VideoInfoView {
  readonly title: string;
  readonly author: string;
  readonly channel?: ChannelRef;
  readonly description: string;
  readonly durationSec: number;
  readonly audioLang?: string;
  readonly segments?: readonly { readonly index: number; readonly title: string; readonly durationSec: number }[];
}

export interface TrackView {
  readonly trackId: string;
  readonly lang: string;
  readonly label: string;
  readonly kind: CaptionKind;
  readonly isOriginalLang?: boolean;
}

export interface CueView {
  readonly start: number;
  readonly duration: number;
  readonly text: string;
}

export interface ChapterView {
  readonly title: string;
  readonly start: number;
  readonly end: number | null;
}

export interface TranscriptBody {
  /** 实际读到的字幕版本：视频、来源、语言和正文指纹。 */
  readonly ref: TranscriptRef;
  readonly trackId: string;
  readonly label: string;
  readonly cues: readonly CueView[];
  readonly segments: readonly TranscriptSegment[];
  /** 来自用户导入的文件时，文件名。 */
  readonly fileName?: string;
}

/**
 * 官方总结的状态：有内容、没有、排队生成中、平台不做这个视频；
 * 要登录、没问成的过一阵再问；还在问是字幕先交了、官方总结还没回来。
 */
export type OfficialStatus = "ok" | "none" | "queued" | "unsupported" | "need-login" | "failed" | "pending";

export interface OutlinePointView {
  readonly timestamp: number | null;
  readonly content: string;
}

export interface OutlineSectionView {
  readonly title: string;
  readonly timestamp: number | null;
  readonly points: readonly OutlinePointView[];
}

/** 平台给的官方总结：摘要和提纲。附带的 AI 字幕只在兜底时当字幕用，不在这里。 */
export interface OfficialSummaryView {
  readonly status: OfficialStatus;
  readonly summary: string;
  readonly outline: readonly OutlineSectionView[];
  /** 有内容时的正文指纹：用官方总结写的结论据此记下依据的是哪一版。 */
  readonly fingerprint?: string;
}

export interface TranscriptView {
  readonly video: VideoKey;
  readonly info: VideoInfoView;
  readonly transcript: TranscriptBody;
  /** 平台列出的字幕轨，换语言用。 */
  readonly tracks: readonly TrackView[];
  /** UP 主分段，没有时是空的。 */
  readonly chapters: readonly ChapterView[];
  /** 站点有官方总结这项能力时才有。 */
  readonly official?: OfficialSummaryView;
  readonly fromCache: boolean;
  /** 时间轴和视频时长对不上，可能不属于这个视频：照常给用，提示一句，不进缓存。 */
  readonly subtitleMismatch?: true;
  /** 刷新取回的字幕对不上，继续用原来那份。 */
  readonly refreshMismatched?: true;
}

/** 读不成字幕时，把已经知道的带回去：没有字幕时这些往往是这个视频唯一能看的内容。 */
export interface TranscriptFailure extends Failure {
  readonly info?: VideoInfoView;
  /** 视频信息也没读到（没登录、被限流、看不了）时，标签页的标题。 */
  readonly tabTitle?: string;
  readonly tracks?: readonly TrackView[];
  readonly chapters?: readonly ChapterView[];
  readonly official?: OfficialSummaryView;
}

export type TranscriptReply = { readonly ok: true; readonly value: TranscriptView } | TranscriptFailure;

/** 本机已有的概览和结论。 */
export interface OverviewView {
  readonly analysis: LearningAnalysis;
  readonly analysisFailures: readonly FailureRange[];
}

/** 读不到字幕的这两种原因要告诉卡片：它据此决定还摆不摆「生成概览」。 */
export type TranscriptUnavailable = "NO_CAPTIONS" | "NEED_LOGIN";

/** 轻量读取的回复：只有卡片要摆的东西，不带字幕、字幕轨和分段。 */
export interface GuidesView {
  readonly mode: "light";
  readonly video: VideoKey;
  readonly info: VideoInfoView;
  readonly official?: OfficialSummaryView;
  readonly overview?: OverviewView;
  /** 本机缓存里有字幕，或者并进的完整读取读到了。false 只说明这次没读字幕，不说明视频没有字幕。 */
  readonly hasTranscript: boolean;
  /** 字幕缓存命中。 */
  readonly fromCache: boolean;
  /** 并进的完整读取读不到字幕的原因。 */
  readonly transcriptError?: TranscriptUnavailable;
}

/** 轻量读取失败：本机已有的概览照样带回去。 */
export interface GuidesFailure extends Failure {
  readonly overview?: OverviewView;
}

export type GuidesReply = { readonly ok: true; readonly value: GuidesView } | GuidesFailure;

export interface VideoCheckRequest {
  readonly video: VideoKey;
}

/** 只有平台明确说找不到这个视频才算不在了；没登录、被限流这些都不挡用户打开原视频。 */
export interface VideoCheckView {
  readonly available: boolean;
}

export interface TranscriptApi {
  "transcript.get": { req: TranscriptGetRequest; res: TranscriptView | GuidesView };
  "video.checkAvailable": { req: VideoCheckRequest; res: VideoCheckView };
}
