// 解释当前画面的请求和回复。路由只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进路由表；这里只有类型，不进包。
// 两个入口：侧边栏点「解释当前画面」，播放页图标点一下（后台先打开侧边栏）。结果都记在后台内存里，
// 侧边栏按标签页来取；截下的画面只用于那一次请求，不存。
import type { ErrorCode } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

/** 一次解释：截帧、等模型、有结果或失败。 */
export interface FrameEntryView {
  readonly id: string;
  readonly tabId: number;
  readonly video: VideoKey;
  readonly state: "running" | "done" | "failed";
  /** 进行到哪一步：查模型、截帧、等模型回答。 */
  readonly phase: "checking" | "capturing" | "thinking" | "finished";
  /** 截到的那一帧的播放时间、尺寸，截到以后才有。 */
  readonly atSec?: number;
  readonly width?: number;
  readonly height?: number;
  readonly explanation?: string;
  /** 模型输出被截断，正文末尾已经注明可能不完整。 */
  readonly truncated?: true;
  readonly error?: { readonly code: ErrorCode; readonly detail?: string };
  readonly createdAt: number;
}

export interface FrameExplainRequest {
  readonly video: VideoKey;
  readonly tabId: number;
}

export interface FrameHereRequest {
  readonly video: VideoKey;
}

export interface FrameHereView {
  /** 侧边栏打开了：结果在侧边栏里看。没打开时页面上提示点简幕图标。 */
  readonly opened: boolean;
}

export interface FrameRecentRequest {
  readonly tabId: number;
}

export interface FrameRecentView {
  /** 这个标签页最近几次，新的在前。 */
  readonly entries: readonly FrameEntryView[];
}

export interface ImageProbeView {
  readonly model: string;
  readonly imageInput: boolean;
}

export interface FrameApi {
  "frame.explain": { req: FrameExplainRequest; res: FrameEntryView };
  "frame.explainHere": { req: FrameHereRequest; res: FrameHereView };
  "frame.recent": { req: FrameRecentRequest; res: FrameRecentView };
  "ai.probeImage": { req: EmptyRequest; res: ImageProbeView };
}

export type FrameRouteName = keyof FrameApi;
