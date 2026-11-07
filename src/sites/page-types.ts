// 内容脚本一侧的契约，要用 DOM 类型，后台的类型检查不含这个文件。
import type { VideoRef } from "../core/video-ref.ts";
import type { SiteRules } from "./types.ts";

// 播广告和找不到视频是两种结果，提示不同。
export type MainVideo =
  | { status: "found"; video: HTMLVideoElement }
  | { status: "ad" }
  | { status: "none" };

// 在内容脚本里跑。带问号的是站点专属能力，调用方没有就不做那一块。
export interface SitePage {
  rules: SiteRules;
  currentRef(): VideoRef | null; // 当前页面的视频身份，不单独证明播放器已切换
  onVideoChange(cb: (ref: VideoRef | null) => void): () => void;
  whenPageReady(signal: AbortSignal): Promise<void>; // 页面框架激活完成才插节点，中止时拒绝
  findMainVideo(): MainVideo;
  hoverIconAnchor(): Element | null;
  watchControls?(cb: (visible: boolean) => void): () => void; // 找到页面信号再实现
  noteShortcut: string | null;
  cardSlot?(): { parent: Element; before: Node | null } | null;
}
