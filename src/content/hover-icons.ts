// 播放器右上角的悬停图标：一个浮层里竖着排几个图标（笔记，构建开关打开时还有解释当前画面）。平时藏着，
// 播放器的控制栏露出来时才露（什么时候露见 reveal.ts），只有图标没有字，结果在图标旁边闪一句。
// 挂在不直接包着视频的那一层，只认鼠标真点在图标上的点击，点的时候再核对一次没被页面改成透明、挪走、铺满、藏起来。
// 被劫持的页面能用 !important 的样式表盖过内联样式，也能把焦点挪到图标上、等用户按空格或回车：
// 这些在点击时尽量拦，图标背后的操作会花用户的额度（解释当前画面还会把画面发出去）。样子核对是尽力而为：
// 盖一层不接收点击的诱饵、改播放器祖先的样子、只在鼠标移上去时才显形，这几种拦不干净，兜底的是后台的限频。
// 鼠标移上去和闪提示时用设置里的主题色，不跟扩展页面的明暗走。小窗时让开，见 mini-player.ts。
import { INJECTED } from "../shared/names.ts";
import { BUTTON_GAP, keepsLook, OVERLAY_INSET, placedAsInjected, pointedAt, type Box, type Look } from "./click-guard.ts";
import { createReveal } from "./reveal.ts";

// 主题强调色的浅色值，和设置里的主题表一致（单元测试核对）。不导入设置模块：它会把整套设置规则带进每个播放页。
export const ACCENT_SWATCHES: Readonly<Record<string, string>> = { ink: "#2a6664", graphite: "#515d9f", ochre: "#8e5729" };
const DEFAULT_SWATCH = "#2a6664";
const swatchOf = (theme: unknown): string => (typeof theme === "string" && Object.hasOwn(ACCENT_SWATCHES, theme) ? ACCENT_SWATCHES[theme] : undefined) ?? DEFAULT_SWATCH;

export const NOTE_TITLE = "在当前时间点记一条笔记（快捷键 n）";
const FLASH_MS = 1800;

// 防点击劫持核对的那几项在内联样式里钉死，点击时和下面的常量比：页面不带 !important 的通用规则改不动它们，
// 带 !important 改了就对不上。不拿注入时记下的样子当基线：页面能在注入前就把样式表放好。
const PINNED = "opacity:1;filter:none;clip-path:none;mask-image:none;transform:none;translate:none;scale:none;rotate:none;zoom:1;mix-blend-mode:normal;margin:0;";
// 没有提示时是一个圆，挂上提示就撑成一条。
const BUTTON_BASE = `display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-width:32px;height:32px;
  padding:0 8px;border:none;border-radius:16px;cursor:pointer;font-size:13px;line-height:1;color:#fff;white-space:nowrap;position:static;${PINNED}`;
const REST_BACKGROUND = "rgba(0,0,0,.5)";
// 藏和露只用可见性和能不能点，不动透明度：防点击劫持的核对拿透明度当依据。
const OVERLAY_STYLE = `position:absolute;top:${OVERLAY_INSET}px;right:${OVERLAY_INSET}px;z-index:9999;display:flex;flex-direction:column;align-items:flex-end;gap:${BUTTON_GAP}px;
  visibility:hidden;pointer-events:none;${PINNED}`;

const SVG_NS = "http://www.w3.org/2000/svg";


/** 一个图标：节点标识、悬停提示、16×16 的线条图形。 */
export interface IconSpec {
  readonly id: string;
  readonly labelClass: string;
  readonly title: string;
  readonly paths: readonly string[];
}

export const NOTE_ICON: IconSpec = {
  id: INJECTED.noteButton,
  labelClass: INJECTED.noteLabel,
  title: NOTE_TITLE,
  paths: ["M8.6 2.4H4.1c-.6 0-1.1.5-1.1 1.1v8.9c0 .6.5 1.1 1.1 1.1h6.2c.6 0 1.1-.5 1.1-1.1V7.9", "M11.2 2.2a1.4 1.4 0 0 1 2 2L9.1 8.3l-2.5.5.5-2.5Z"],
};

export interface HoverIconEntry {
  readonly spec: IconSpec;
  readonly onPress: () => void;
}

export interface HoverIcon {
  /** 在图标旁边闪一句提示，闪着的时候浮层一直露着；ms 为 0 时一直挂着，直到下一次提示。 */
  readonly flash: (text: string, ms?: number) => void;
  readonly setTitle: (title: string) => void;
}

export interface HoverIconsDeps {
  readonly document: Document;
  /** 挂浮层的那一层，没有时这一轮不挂。 */
  readonly anchor: () => Element | null;
  /** 从上往下的顺序。 */
  readonly icons: readonly HoverIconEntry[];
}

export interface HoverIcons {
  /** 定时自查时调：被页面重渲染摘掉了就补回去。 */
  readonly ensure: () => void;
  readonly overlay: () => HTMLElement | null;
  readonly setAccent: (theme: unknown) => void;
  /** 页面的控制栏露没露着；null 是页面这会儿没给信号。 */
  readonly setControls: (visible: boolean | null) => void;
  /** 按节点标识取图标，不在这个浮层里时是 null。 */
  readonly icon: (id: string) => HoverIcon | null;
  /** 在图标下面摆一块附加内容（null 撤掉），摆着的时候浮层一直露着。 */
  readonly attach: (node: HTMLElement | null) => void;
  readonly remove: () => void;
}

interface IconState {
  readonly entry: HoverIconEntry;
  button: HTMLButtonElement | null;
  label: HTMLSpanElement | null;
  /** 自己建的图标图形：点击坐标处是它（或它里面的线条）也算点在按钮上。 */
  icon: SVGSVGElement | null;
  flashTimer: ReturnType<typeof setTimeout> | null;
  title: string;
  over: boolean;
  hinting: boolean;
  onClick: ((event: MouseEvent) => void) | null;
}

function rgbOf(swatch: string): string {
  const value = Number.parseInt(swatch.slice(1), 16);
  return `${(value >> 16) & 255},${(value >> 8) & 255},${value & 255}`;
}

export function createHoverIcons({ document, anchor, icons }: HoverIconsDeps): HoverIcons {
  const view = document.defaultView;
  let accent = rgbOf(swatchOf(undefined));
  let overlay: HTMLElement | null = null;
  let extra: HTMLElement | null = null;
  let overOverlay = false;
  let watched: Element | null = null;
  const states: IconState[] = icons.map((entry) => ({
    entry,
    button: null,
    label: null,
    icon: null,
    flashTimer: null,
    title: entry.spec.title,
    over: false,
    hinting: false,
    onClick: null,
  }));

  const paint = (state: IconState): void => {
    if (!state.button) return;
    const lit = state.over || state.hinting;
    state.button.style.cssText = `${BUTTON_BASE}background:${lit ? `rgba(${accent},.92);box-shadow:0 2px 8px rgba(0,0,0,.24)` : REST_BACKGROUND};`;
  };

  function show(shown: boolean): void {
    if (!overlay) return;
    // 没变就不写：页面自己的变化监听看得到每一次属性写入。
    const visibility = shown ? "visible" : "hidden";
    if (overlay.style.visibility !== visibility) overlay.style.visibility = visibility;
    const pointerEvents = shown ? "auto" : "none";
    if (overlay.style.pointerEvents !== pointerEvents) overlay.style.pointerEvents = pointerEvents;
  }
  const reveal = createReveal({ onChange: show });

  const syncHold = (): void => reveal.hold(extra !== null || states.some((state) => state.hinting));

  function setOverOverlay(next: boolean): void {
    if (overOverlay === next) return;
    overOverlay = next;
    if (!next) for (const state of states) setOver(state, false);
    reveal.hover(next);
  }

  function setOver(state: IconState, next: boolean): void {
    if (state.over === next) return;
    state.over = next;
    paint(state);
  }

  function setHint(state: IconState, text: string): void {
    state.hinting = text !== "";
    if (state.label) {
      state.label.textContent = text;
      state.label.style.display = state.hinting ? "inline" : "none";
    }
    paint(state);
    syncHold();
  }

  const onPlayerMove = (): void => reveal.pointerMoved();
  const onPlayerLeave = (): void => {
    setOverOverlay(false);
    reveal.pointerLeft();
  };
  const onOverlayEnter = (): void => setOverOverlay(true);
  const onOverlayLeave = (): void => setOverOverlay(false);

  // 页面没给控制栏信号时靠鼠标在播放器上动没动；播放器那一层被页面换掉了就改听新的。
  function watch(player: Element | null): void {
    if (player === watched) return;
    watched?.removeEventListener("pointermove", onPlayerMove);
    watched?.removeEventListener("pointerleave", onPlayerLeave);
    watched = player;
    player?.addEventListener("pointermove", onPlayerMove, { passive: true });
    player?.addEventListener("pointerleave", onPlayerLeave, { passive: true });
  }

  function lookOf(element: Element): Look | null {
    try {
      const style = view?.getComputedStyle(element);
      if (!style) return null;
      return {
        opacity: style.opacity,
        visibility: style.visibility,
        position: style.position,
        filter: style.filter,
        clipPath: style.clipPath,
        mask: style.maskImage || style.getPropertyValue("-webkit-mask-image"),
        transform: style.transform,
        translate: style.translate,
        scale: style.scale,
        rotate: style.rotate,
        zoom: style.zoom,
        blend: style.mixBlendMode,
        color: style.color,
        background: style.backgroundColor,
        stroke: style.stroke,
      };
    } catch {
      return null;
    }
  }

  const boxOf = (element: Element): Box => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom };
  };

  // 锚点的内边距框：浮层的 top、right 从这里量。
  const paddingBoxOf = (element: Element): Box => {
    const box = element.getBoundingClientRect();
    const left = box.left + element.clientLeft;
    const top = box.top + element.clientTop;
    return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
  };

  // 点击时的全部核对：节点还是自己建的那几个、挂在原来的地方，样子是钉死的那个，位置是注入时的位置。
  // 不放行时回一句原因，只打到控制台，日用时遇到误拦好查。
  function refusal(state: IconState, index: number): string | null {
    const { button, label, icon } = state;
    const host = anchor();
    if (!button || !label || !icon || !overlay || !host) return "节点不在";
    if (button.parentElement !== overlay || overlay.parentElement !== host) return "被挪了地方";
    if (button.childNodes.length !== 2 || button.firstChild !== icon || button.lastChild !== label) return "里面被塞了别的节点";
    if (!keepsLook(lookOf(button), "button")) return "按钮的样子被改过";
    if (!keepsLook(lookOf(overlay), "overlay")) return "浮层的样子被改过";
    if (!keepsLook(lookOf(icon), "icon")) return "图标的样子被改过";
    if (!placedAsInjected({ anchor: paddingBoxOf(host), overlay: boxOf(overlay), button: boxOf(button), index, hinting: state.hinting })) return "位置或大小被改过";
    return null;
  }

  const hit = (x: number, y: number): Element | null => {
    try {
      return document.elementFromPoint(x, y);
    } catch {
      return null;
    }
  };

  function iconOf(spec: IconSpec): SVGSVGElement {
    // 逐个节点建，不用 innerHTML：页面开了 Trusted Types 时 innerHTML 会被拦。
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
      svg.setAttribute(name, value);
    }
    for (const d of spec.paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function ensureOverlay(): HTMLElement | null {
    const player = anchor();
    if (!player) return null;
    watch(player);
    if (overlay?.isConnected && overlay.parentElement === player) return overlay;
    overlay?.remove();
    setOverOverlay(false);
    // 浮动定位要一个定位上下文；只在还是 static 时写，小窗时页面自己改成的 fixed 不动。
    if (view?.getComputedStyle(player).position === "static") (player as HTMLElement).style.position = "relative";
    const node = document.createElement("div");
    node.id = INJECTED.overlay;
    node.style.cssText = OVERLAY_STYLE;
    node.addEventListener("pointerenter", onOverlayEnter);
    node.addEventListener("pointerleave", onOverlayLeave);
    player.appendChild(node);
    overlay = node;
    show(reveal.shown());
    return node;
  }

  function create(state: IconState): HTMLButtonElement {
    const { spec, onPress } = state.entry;
    const node = document.createElement("button");
    node.id = spec.id;
    node.type = "button";
    node.title = state.title;
    node.setAttribute("aria-label", state.title);
    // 只认鼠标点，按键不算：不进 Tab 顺序，免得聚焦了却按不动。笔记另有 n 键，解释画面在侧边栏也有入口。
    node.tabIndex = -1;
    const text = document.createElement("span");
    text.className = spec.labelClass;
    text.style.display = "none";
    const icon = iconOf(spec);
    node.append(icon, text);
    const own = (target: Element): boolean => target === node || target === text || target === icon || target.parentNode === icon;
    // 页面脚本能对按钮调 click() 或派发合成点击，也能把焦点挪过来等用户按键；只认鼠标真点在按钮上的那一下。
    state.onClick = (event: MouseEvent): void => {
      if (!event.isTrusted || !state.button) return;
      event.preventDefault();
      event.stopPropagation();
      const reason = pointedAt(event, boxOf(node), own, hit) ? refusal(state, states.indexOf(state)) : "不是鼠标点在图标上";
      if (reason === null) onPress();
      else console.debug(`简幕：这次点击没放行（${reason}）`);
    };
    node.addEventListener("click", state.onClick);
    node.addEventListener("pointerenter", () => setOver(state, true));
    node.addEventListener("pointerleave", () => setOver(state, false));
    state.button = node;
    state.label = text;
    state.icon = icon;
    paint(state);
    return node;
  }

  function placeAll(host: HTMLElement): void {
    // 按顺序排：被摘掉补回来的也回到原位，附加内容总在最下面。
    const buttons = states.map((state) => state.button ?? create(state));
    [...buttons, ...(extra ? [extra] : [])].forEach((node, index) => {
      if (host.children[index] === node) return;
      host.insertBefore(node, host.children[index] ?? null);
    });
  }

  function flashOf(state: IconState): HoverIcon["flash"] {
    return (text, ms = FLASH_MS) => {
      if (!state.label) return;
      if (state.flashTimer !== null) clearTimeout(state.flashTimer);
      state.flashTimer = null;
      setHint(state, text);
      if (ms > 0) {
        state.flashTimer = setTimeout(() => {
          state.flashTimer = null;
          setHint(state, "");
        }, ms);
      }
    };
  }

  const handles = new Map<string, HoverIcon>(
    states.map((state) => [
      state.entry.spec.id,
      {
        flash: flashOf(state),
        setTitle(next: string) {
          state.title = next;
          state.button?.setAttribute("aria-label", next);
          if (state.button) state.button.title = next;
        },
      },
    ]),
  );

  return {
    ensure() {
      const host = ensureOverlay();
      if (!host) return;
      // 图标在鼠标底下被藏起来（进了小窗）时收不到移出事件，这里补认一次。
      if (overOverlay && !host.matches(":hover")) setOverOverlay(false);
      placeAll(host);
    },
    overlay: () => (overlay?.isConnected ? overlay : null),
    setAccent(theme) {
      accent = rgbOf(swatchOf(theme));
      for (const state of states) paint(state);
    },
    setControls: (visible) => reveal.controls(visible),
    icon: (id) => handles.get(id) ?? null,
    attach(node) {
      extra?.remove();
      extra = node;
      syncHold();
      if (overlay?.isConnected) placeAll(overlay);
    },
    remove() {
      for (const state of states) {
        if (state.flashTimer !== null) clearTimeout(state.flashTimer);
        if (state.onClick) state.button?.removeEventListener("click", state.onClick);
        state.button?.remove();
        state.button = null;
        state.label = null;
        state.icon = null;
      }
      reveal.stop();
      watch(null);
      extra?.remove();
      extra = null;
      overlay?.remove();
      overlay = null;
    },
  };
}
