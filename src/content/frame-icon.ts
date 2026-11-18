// 播放页上「解释当前画面」的图标：和笔记图标同一个浮层。只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 点了先在页面上看能不能截（没视频、正在播广告、视频还在切换就地提示），能截就交给后台：后台先打开侧边栏，
// 再向这个页面要当前一帧、请模型解释，结果显示在侧边栏里。截下的画面不落盘，只用于那一次请求。
// 模块顶层只放字面量和函数，理由见 frame.ts 开头。
import { describe } from "../core/errors.ts";
import type { VideoKey } from "../core/video-ref.ts";
import type { FrameRefusal } from "../shared/messages/content.ts";
import { INJECTED } from "../shared/names.ts";
import type { MainVideo } from "../sites/page-types.ts";
import type { FrameTool } from "./frame.ts";
import type { HoverIconEntry, HoverIcons, IconSpec } from "./hover-icons.ts";
import type { ContentRuntime } from "./runtime.ts";

export const FRAME_TITLE = "解释当前画面";
const PANEL_HINT = "结果在侧边栏：点浏览器工具栏上的简幕图标打开侧边栏查看。";

export function frameIcon(): IconSpec {
  return {
    id: INJECTED.frameButton,
    labelClass: INJECTED.frameLabel,
    title: FRAME_TITLE,
    // 取景框四个角，中间一个点。
    paths: ["M2.5 5.5v-2a1 1 0 0 1 1-1h2", "M10.5 2.5h2a1 1 0 0 1 1 1v2", "M13.5 10.5v2a1 1 0 0 1-1 1h-2", "M5.5 13.5h-2a1 1 0 0 1-1-1v-2", "M8 8h.01"],
  };
}

/** 浮层里排在笔记图标下面的那一项；没有截帧工具时不排。 */
export function frameIconEntries(tool: FrameTool | undefined, onPress: () => void): HoverIconEntry[] {
  return tool ? [{ spec: frameIcon(), onPress }] : [];
}

/** 闪在图标旁边的短说法，完整说明放在悬停提示里。 */
export const FRAME_REFUSALS: Readonly<Record<FrameRefusal, { readonly short: string; readonly long: string }>> = {
  NO_VIDEO: { short: "没找到视频", long: "页面上没找到视频，不截。" },
  AD_PLAYING: { short: "正在播广告", long: "正在播广告，等广告放完再截。" },
  VIDEO_CHANGED: { short: "视频还在切换", long: "页面上的视频换了或者还在切换，不截。" },
  FRAME_NOT_READY: { short: "画面还没好", long: "画面还没加载好，等视频出画面再截。" },
  PROTECTED: { short: "画面受保护", long: "这个视频是加密播放，或者认不出是不是加密播放，不截。" },
  CANVAS_TAINTED: { short: "读不到画面", long: "浏览器不让读这个视频的画面，不截。" },
  NOT_FOREGROUND: { short: "不在前台", long: "视频页不在前台，切回来再截。" },
};

export interface FramePressDeps {
  readonly icons: HoverIcons;
  /** 交给后台：先打开侧边栏，再截帧、请模型解释。 */
  readonly runtime: Pick<ContentRuntime, "send">;
  readonly currentKey: () => VideoKey | null;
  readonly findMainVideo: () => MainVideo;
  /** 播放器确实在放当前地址上的视频。 */
  readonly confirmed: () => boolean;
  /** 扩展断了联系：交给界面收场。 */
  readonly gone: () => boolean;
  readonly onGone: () => void;
}

/** 回点图标时要做的事：页面上看得出的拒绝就地提示，不发；其余交给后台，结果在侧边栏里看。 */
export function createFramePress({ icons, runtime, currentKey, findMainVideo, confirmed, gone, onGone }: FramePressDeps): () => Promise<void> {
  let busy = false;
  const icon = (): ReturnType<HoverIcons["icon"]> => icons.icon(INJECTED.frameButton);
  const refuse = (code: FrameRefusal): void => {
    const refusal = FRAME_REFUSALS[code];
    icon()?.setTitle(refusal.long);
    icon()?.flash(refusal.short);
  };

  return async () => {
    if (gone()) return onGone();
    if (busy) return;
    const video = currentKey();
    const main = findMainVideo();
    if (!video || main.status === "none") return refuse("NO_VIDEO");
    if (main.status === "ad") return refuse("AD_PLAYING");
    if (!confirmed()) return refuse("VIDEO_CHANGED");
    busy = true;
    icon()?.flash("发送中…", 0);
    try {
      const reply = await runtime.send("frame.explainHere", { video });
      if (gone()) return onGone();
      if (!reply.ok) {
        icon()?.setTitle(describe(reply.code, reply.detail));
        icon()?.flash(reply.code === "FRAME_RATE_LIMITED" ? "点得太多了" : "没发出去");
        return;
      }
      icon()?.setTitle(reply.value.opened ? FRAME_TITLE : PANEL_HINT);
      icon()?.flash(reply.value.opened ? "结果在侧边栏" : "点简幕图标看结果");
    } finally {
      busy = false;
    }
  };
}
