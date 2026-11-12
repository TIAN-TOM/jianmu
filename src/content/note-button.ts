// 播放器右上角的笔记按钮：挂在不直接包着视频的那一层，只认真实点击，点的时候再核对一次没被页面改成透明、铺满。
// 颜色跟着设置里的主题，按钮落在浅色的网页上，不跟扩展页面的明暗走。小窗时让开，见 mini-player.ts。
import { INJECTED } from "../shared/names.ts";

// 主题强调色的浅色值，和设置里的主题表一致（单元测试核对）。不导入设置模块：它会把整套设置规则带进每个播放页。
export const ACCENT_SWATCHES: Readonly<Record<string, string>> = { ink: "#2a6664", graphite: "#515d9f", ochre: "#8e5729" };
const DEFAULT_SWATCH = "#2a6664";
const swatchOf = (theme: unknown): string => (typeof theme === "string" && Object.hasOwn(ACCENT_SWATCHES, theme) ? ACCENT_SWATCHES[theme] : undefined) ?? DEFAULT_SWATCH;

export const NOTE_TITLE = "在当前时间点记一条笔记（快捷键 n）";
const NOTE_TEXT = "笔记";
const FLASH_MS = 1800;

const BUTTON_BASE = `display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:none;border-radius:6px;cursor:pointer;
  font-size:13px;line-height:1.4;color:#fff;white-space:nowrap;`;
const OVERLAY_STYLE = "position:absolute;top:12px;right:12px;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = ["M8.6 2.4H4.1c-.6 0-1.1.5-1.1 1.1v8.9c0 .6.5 1.1 1.1 1.1h6.2c.6 0 1.1-.5 1.1-1.1V7.9", "M11.2 2.2a1.4 1.4 0 0 1 2 2L9.1 8.3l-2.5.5.5-2.5Z"];

// 防点击劫持：自己的按钮从不设透明度，也不会大过一行字。
const MAX_WIDTH = 320;
const MAX_HEIGHT = 96;
const MIN_OPACITY = 0.5;

export interface NoteButtonDeps {
  readonly document: Document;
  /** 挂按钮的那一层，没有时这一轮不挂。 */
  readonly anchor: () => Element | null;
  readonly onPress: () => void;
}

export interface NoteButton {
  /** 定时自查时调：被页面重渲染摘掉了就补回去。 */
  readonly ensure: () => void;
  readonly overlay: () => HTMLElement | null;
  readonly setAccent: (theme: unknown) => void;
  /** 短暂换一下按钮上的字；ms 为 0 时一直挂着，直到下一次换字。 */
  readonly flash: (text: string, ms?: number) => void;
  readonly setTitle: (title: string) => void;
  readonly remove: () => void;
}

interface Look {
  readonly opacity: number;
  readonly visibility: string;
}

function rgbOf(swatch: string): string {
  const value = Number.parseInt(swatch.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
}

export function createNoteButton({ document, anchor, onPress }: NoteButtonDeps): NoteButton {
  const view = document.defaultView;
  let accent = rgbOf(swatchOf(undefined));
  let overlay: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let label: HTMLSpanElement | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let title = NOTE_TITLE;
  const looks = new WeakMap<Element, Look>();

  const paint = (): void => {
    if (button) button.style.cssText = `${BUTTON_BASE}background:rgba(${accent},.92);box-shadow:0 2px 8px rgba(0,0,0,.24);`;
  };

  function lookOf(element: Element): Look | null {
    try {
      const style = view?.getComputedStyle(element);
      const opacity = Number.parseFloat(style?.opacity ?? "");
      return { opacity: Number.isFinite(opacity) ? opacity : 1, visibility: style?.visibility || "visible" };
    } catch {
      return null;
    }
  }

  // 注入那一刻播放器可能还藏着，可见性只要求现在可见；透明度不比注入时低。
  function keepsLook(element: Element): boolean {
    const now = lookOf(element);
    if (!now || now.visibility !== "visible" || now.opacity < MIN_OPACITY) return false;
    const injected = looks.get(element);
    return !injected || now.opacity >= injected.opacity - 0.01;
  }

  function looksInjected(target: HTMLButtonElement): boolean {
    if (!keepsLook(target) || (overlay && !keepsLook(overlay))) return false;
    const box = target.getBoundingClientRect();
    return box.width <= MAX_WIDTH && box.height <= MAX_HEIGHT;
  }

  function icon(): SVGSVGElement {
    // 逐个节点建，不用 innerHTML：页面开了 Trusted Types 时 innerHTML 会被拦。
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(name, value);
    }
    for (const d of ICON_PATHS) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function ensureOverlay(): HTMLElement | null {
    const player = anchor();
    if (!player) return null;
    if (overlay?.isConnected && overlay.parentElement === player) return overlay;
    overlay?.remove();
    // 浮动定位要一个定位上下文；只在还是 static 时写，小窗时页面自己改成的 fixed 不动。
    if (view?.getComputedStyle(player).position === "static") (player as HTMLElement).style.position = "relative";
    const node = document.createElement("div");
    node.id = INJECTED.overlay;
    node.style.cssText = OVERLAY_STYLE;
    player.appendChild(node);
    overlay = node;
    return node;
  }

  function onClick(event: MouseEvent): void {
    // 页面脚本能对按钮调 click() 或派发合成点击；记笔记会请模型润色、花用户的额度。
    if (!event.isTrusted || !button) return;
    event.preventDefault();
    event.stopPropagation();
    if (looksInjected(button)) onPress();
  }

  function create(): HTMLButtonElement {
    const node = document.createElement("button");
    node.id = INJECTED.noteButton;
    node.type = "button";
    node.title = title;
    const text = document.createElement("span");
    text.className = INJECTED.noteLabel;
    text.textContent = NOTE_TEXT;
    node.append(icon(), text);
    node.addEventListener("click", onClick);
    button = node;
    label = text;
    paint();
    return node;
  }

  return {
    ensure() {
      const host = ensureOverlay();
      if (!host) return;
      if (button?.isConnected && button.parentElement === host) return;
      host.appendChild(button ?? create());
      for (const element of [host, button]) {
        const look = element && lookOf(element);
        if (element && look) looks.set(element, look);
      }
    },
    overlay: () => (overlay?.isConnected ? overlay : null),
    setAccent(theme) {
      accent = rgbOf(swatchOf(theme));
      paint();
    },
    flash(text, ms = FLASH_MS) {
      if (!label) return;
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = null;
      label.textContent = text;
      if (ms > 0) {
        flashTimer = setTimeout(() => {
          flashTimer = null;
          if (label) label.textContent = NOTE_TEXT;
        }, ms);
      }
    },
    setTitle(next) {
      title = next;
      if (button) button.title = next;
    },
    remove() {
      if (flashTimer !== null) clearTimeout(flashTimer);
      button?.removeEventListener("click", onClick);
      button?.remove();
      overlay?.remove();
      button = null;
      label = null;
      overlay = null;
    },
  };
}
