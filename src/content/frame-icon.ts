// 播放页上「解释当前画面」的图标：和笔记图标同一个浮层。只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 现在点了只截一帧摆在图标下面，给开发者本人在真实页面上核对截到的画面和屏幕一致；交给模型解释的那一步接上以后换掉。
// 截下来的画面只画在这块预览里，不落盘、不发出去，关掉预览就没了。
// 模块顶层只放字面量和函数，理由见 frame.ts 开头。
import type { FrameRefusal } from "../shared/messages/content.ts";
import { INJECTED } from "../shared/names.ts";
import { JPEG_DATA_URL_PREFIX, type FrameTool } from "./frame.ts";
import type { HoverIconEntry, HoverIcons, IconSpec } from "./hover-icons.ts";

export const FRAME_TITLE = "解释当前画面";

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

/** 预览留多久。 */
export const PREVIEW_MS = 20_000;
const PREVIEW_WIDTH = 240;
const PREVIEW_STYLE = `box-sizing:border-box;width:252px;padding:6px;border-radius:8px;background:rgba(0,0,0,.72);
  color:#fff;font-size:12px;line-height:1.4;cursor:pointer;`;

export interface FramePressDeps {
  readonly document: Document;
  readonly icons: HoverIcons;
  readonly tool: FrameTool;
  /** 点下去那一刻的播放时间，用来算截到的帧差了多久。 */
  readonly clickedAt: () => number | null;
  /** 扩展断了联系：交给界面收场。 */
  readonly gone: () => boolean;
}

const seconds = (value: number): string => `${value.toFixed(2)} 秒`;

// 预览不用 data URL 当图片地址：页面的内容安全策略管得到插进页面的图片。先解码再画到画布上。
async function bitmapOf(dataUrl: string): Promise<ImageBitmap> {
  const binary = atob(dataUrl.slice(JPEG_DATA_URL_PREFIX.length));
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}

/** 回点图标时要做的事。 */
export function createFramePress({ document, icons, tool, clickedAt, gone }: FramePressDeps): () => Promise<void> {
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const icon = (): ReturnType<HoverIcons["icon"]> => icons.icon(INJECTED.frameButton);

  function dismiss(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    icons.attach(null);
  }

  async function preview(dataUrl: string, caption: string): Promise<void> {
    const bitmap = await bitmapOf(dataUrl);
    const box = document.createElement("div");
    box.id = INJECTED.framePreview;
    box.style.cssText = PREVIEW_STYLE;
    box.title = "点一下关掉";
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.style.cssText = `display:block;width:${PREVIEW_WIDTH}px;height:auto;`;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const text = document.createElement("div");
    text.style.cssText = "margin-top:4px;white-space:normal;";
    text.textContent = caption;
    box.append(canvas, text);
    box.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    });
    icons.attach(box);
    timer = setTimeout(dismiss, PREVIEW_MS);
  }

  return async () => {
    if (busy || gone()) return;
    busy = true;
    dismiss();
    const at = clickedAt();
    icon()?.flash("截取中…", 0);
    try {
      const reply = await tool.capture();
      if (gone()) return;
      if (!reply.ok) {
        const refusal = FRAME_REFUSALS[reply.code];
        icon()?.setTitle(refusal.long);
        icon()?.flash(refusal.short);
        return;
      }
      const { width, height, atSec } = reply.value;
      const lag = at === null ? "" : `，比点下去晚 ${Math.round((atSec - at) * 1000)} 毫秒`;
      icon()?.setTitle(FRAME_TITLE);
      icon()?.flash("已截取");
      await preview(reply.value.dataUrl, `画面验证：${width}×${height}，第 ${seconds(atSec)}${lag}。只在这里显示，不保存、不发送。`);
    } catch {
      icon()?.flash(FRAME_REFUSALS.FRAME_NOT_READY.short);
    } finally {
      busy = false;
    }
  };
}
