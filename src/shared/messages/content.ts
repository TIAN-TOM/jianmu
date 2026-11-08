// 后台和侧边栏发给内容脚本的播放器指令。这里只有类型，实现随内容脚本加。
// 每条指令都带视频身份，内容脚本核对的是播放器上正在放的视频，对不上就拒绝。
import type { VideoKey } from "../../core/video-ref.ts";

/** 播放器眼下的状态。正在播广告时不给播放时间。 */
export type PlayerState =
  | { readonly status: "playing" | "paused"; readonly atSec: number; readonly durationSec: number }
  | { readonly status: "ad" };

/** 截下来的一帧画面。 */
export interface FrameCapture {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly atSec: number;
  readonly video: VideoKey;
}

/** 三条指令都可能遇到的：视频已换、正在播广告、找不到视频。 */
export type PlayerRefusal = "VIDEO_CHANGED" | "AD_PLAYING" | "NO_VIDEO";

/** 截帧另外几种拒绝：画面没加载好、受版权保护、画布被污染、标签页不在前台。 */
export type FrameRefusal = PlayerRefusal | "FRAME_NOT_READY" | "PROTECTED" | "CANVAS_TAINTED" | "NOT_FOREGROUND";

export interface ContentCommands {
  "player.getState": { req: { readonly video: VideoKey }; res: PlayerState; refusal: Exclude<PlayerRefusal, "AD_PLAYING"> };
  "player.seek": { req: { readonly video: VideoKey; readonly atSec: number }; res: { readonly atSec: number }; refusal: PlayerRefusal };
  "player.captureFrame": { req: { readonly video: VideoKey; readonly maxEdge: number }; res: FrameCapture; refusal: FrameRefusal };
}

export type ContentCommandName = keyof ContentCommands;

/** 发给内容脚本的信封。 */
export type ContentCommand = {
  [K in ContentCommandName]: { readonly type: K; readonly req: ContentCommands[K]["req"] };
}[ContentCommandName];

export type ContentReply<K extends ContentCommandName> =
  | { readonly ok: true; readonly value: ContentCommands[K]["res"] }
  | { readonly ok: false; readonly code: ContentCommands[K]["refusal"] };
