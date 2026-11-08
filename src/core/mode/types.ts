// 模式和观看会话的类型。规则在 decide.ts，会话由后台按标签页记，页面只读这里的视图。
import type { VideoKey } from "../video-ref.ts";

/** 速览和精读。 */
export type Mode = "skim" | "study";

/** 这次的模式是怎么定下来的：手动选的、频道偏好、短视频、默认、播放满时长自动切的。 */
export type ModeSource = "manual" | "channel" | "short" | "default" | "auto";

/** 卡片在这个标签页上被手动展开或收起，换视频即失效。 */
export type CardOverride = "expanded" | "collapsed";

/** 给侧边栏和卡片看的观看会话。 */
export interface SessionView {
  readonly video: VideoKey;
  readonly mode: Mode;
  readonly modeSource: ModeSource;
  readonly autoSwitched: boolean;
  readonly playedSec: number;
  readonly cardOverride?: CardOverride;
}
