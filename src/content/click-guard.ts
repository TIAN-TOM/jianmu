// 悬停图标点击时的防劫持核对：纯函数，不碰页面，单元测试直接调。怎么用见 hover-icons.ts。
// 被劫持的页面能用 !important 的样式表改样子、挪位置、撑大，能把按钮里的节点撑成铺满视口的透明层，
// 也能把焦点挪到图标上等用户按键；这里核对的是点击那一刻的计算样式、几何位置和点击本身。

/** 浮层离锚点内边距框右边（站点没另给时也是上沿）的距离、按钮的边长、按钮之间的间距，hover-icons.ts 的内联样式也用这几个数。 */
export const OVERLAY_INSET = 12;
export const BUTTON_SIZE = 32;
export const BUTTON_GAP = 8;
// 防点击劫持：按钮挂着提示时最宽一行字；字和图标看得清，底色至少半透明，字和底色的对比度至少 3:1。
export const MAX_WIDTH = 320;
/** 图标图形的边长，hover-icons.ts 建图标时也用这个数。 */
export const ICON_SIZE = 16;
const MIN_TEXT_ALPHA = 0.9;
const MIN_BACKGROUND_ALPHA = 0.4;
const MIN_CONTRAST = 3;
const MIN_STROKE_WIDTH = 1;
// 几何位置的容差：取整、高分屏的小数像素。
const SLACK = 2;

/** 点击时核对的样子，取自计算样式，原样是字符串。 */
export interface Look {
  readonly opacity: string;
  readonly visibility: string;
  readonly display: string;
  readonly position: string;
  readonly filter: string;
  readonly clipPath: string;
  readonly mask: string;
  readonly transform: string;
  readonly translate: string;
  readonly scale: string;
  readonly rotate: string;
  readonly zoom: string;
  readonly blend: string;
  readonly color: string;
  readonly background: string;
  readonly backgroundImage: string;
  readonly backgroundClip: string;
  /** 四条边框的宽度，空格隔开。 */
  readonly border: string;
  readonly shadow: string;
  readonly stroke: string;
  readonly strokeOpacity: string;
  readonly strokeWidth: string;
  readonly strokeDash: string;
}

/** 视口里的一个矩形。 */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

type Rgba = readonly [number, number, number, number];

/** 颜色的各分量，0–1；认不出或超出 0–1 是 null。只认计算样式会给的 rgb()、rgba() 和 transparent。 */
function rgbaOf(color: string): Rgba | null {
  const value = color.trim().toLowerCase();
  if (value === "transparent") return [0, 0, 0, 0];
  const match = /^rgba?\(([^)]*)\)$/.exec(value);
  if (!match) return null;
  const parts = (match[1] ?? "").split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const channel = (part: string | undefined): number => Number.parseFloat(part ?? "") / 255;
  const alphaPart = parts[3];
  const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith("%") ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart);
  const result = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha] as const;
  return result.every((part) => Number.isFinite(part) && part >= 0 && part <= 1) ? result : null;
}

/** 计算样式里颜色的不透明度，认不出的按 0。 */
export function alphaOf(color: string): number {
  return rgbaOf(color)?.[3] ?? 0;
}

// 相对亮度，按 sRGB 换成线性值再加权，不管透明度。
function luminanceOf([red, green, blue]: Rgba): number {
  const linear = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

// 半透明的底色叠在一层灰上合成出来的亮度，base 0 是纯黑、1 是纯白。
function luminanceOver([red, green, blue, alpha]: Rgba, base: number): number {
  const mix = (value: number): number => value * alpha + base * (1 - alpha);
  return luminanceOf([mix(red), mix(green), mix(blue), 1]);
}

const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * 字和底色在最坏情况下的对比度（按 WCAG 的算法）：认不出的按 0。
 * 底色半透明时后面透上来什么颜色由页面定，所以底色分别垫在纯黑、纯白上合成，字的亮度要落在两个结果的同一侧，取两个对比度里小的；
 * 落在两个结果之间时，总有一种垫底能让底色和字一样亮，按 1 算。黑底黑字、半透明白底配灰字这类看不见的，在这里拦。
 */
export function contrastOf(text: string, background: string): number {
  const ink = rgbaOf(text);
  const back = rgbaOf(background);
  if (!ink || !back) return 0;
  const lum = luminanceOf(ink);
  const overBlack = luminanceOver(back, 0);
  const overWhite = luminanceOver(back, 1);
  if ((lum - overBlack) * (lum - overWhite) < 0) return 1;
  return Math.min(ratio(lum, overBlack), ratio(lum, overWhite));
}

/**
 * 现在的样子是不是钉死的那个：看得见、完全不透明，没有滤镜、裁剪、遮罩、变形、缩放、混合模式，定位方式没被改。
 * 按钮另要字和底色看得见、对比度够，底色上不另铺图、不加边框和内阴影；图标的描边看得见。
 * 线条（path）和提示文字是真正画出来的东西，拿它们自己的颜色和按钮的底色（backdrop）比。读不到的一律不放行。
 */
export function keepsLook(now: Look | null, kind: "button" | "overlay" | "icon" | "path" | "label", backdrop = ""): boolean {
  if (!now || now.visibility !== "visible" || now.display === "none" || !(Number.parseFloat(now.opacity) >= 0.99)) return false;
  if ([now.filter, now.clipPath, now.mask, now.transform, now.translate, now.scale, now.rotate].some((value) => value !== "none")) return false;
  if (now.zoom !== "1" || now.blend !== "normal") return false;
  if (kind === "overlay") return now.position === "absolute";
  if (kind === "icon") return alphaOf(now.stroke) >= MIN_TEXT_ALPHA;
  if (kind === "path") {
    return (
      alphaOf(now.stroke) >= MIN_TEXT_ALPHA &&
      Number.parseFloat(now.strokeOpacity) >= 0.99 &&
      Number.parseFloat(now.strokeWidth) >= MIN_STROKE_WIDTH &&
      now.strokeDash === "none" &&
      contrastOf(now.stroke, backdrop) >= MIN_CONTRAST
    );
  }
  if (kind === "label") return alphaOf(now.color) >= MIN_TEXT_ALPHA && contrastOf(now.color, backdrop) >= MIN_CONTRAST;
  return (
    now.position === "static" &&
    now.backgroundImage === "none" &&
    now.backgroundClip === "border-box" &&
    now.border.split(" ").every((width) => Number.parseFloat(width) === 0) &&
    !now.shadow.includes("inset") &&
    alphaOf(now.color) >= MIN_TEXT_ALPHA &&
    alphaOf(now.background) >= MIN_BACKGROUND_ALPHA &&
    contrastOf(now.color, now.background) >= MIN_CONTRAST
  );
}

/**
 * 按钮还在注入时的位置：浮层贴着锚点的内边距框右上角（离上沿 top），按钮从上往下排，32 高，没挂提示时 32 宽，图标 16 见方、在按钮里面。
 * 页面不改定位方式也能用 top、right、margin、宽高把按钮挪到视频正中、撑成一块热区，把图标缩没、挪出按钮，在这里拦。
 */
export function placedAsInjected(input: {
  readonly anchor: Box;
  readonly overlay: Box;
  readonly button: Box;
  readonly icon: Box;
  readonly index: number;
  readonly hinting: boolean;
  /** 注入时浮层离锚点上沿的距离。 */
  readonly top: number;
}): boolean {
  const { anchor, overlay, button, icon, index, hinting, top } = input;
  const near = (value: number, expected: number): boolean => Math.abs(value - expected) <= SLACK;
  const width = button.right - button.left;
  return (
    near(icon.right - icon.left, ICON_SIZE) &&
    near(icon.bottom - icon.top, ICON_SIZE) &&
    icon.left >= button.left - SLACK &&
    icon.right <= button.right + SLACK &&
    icon.top >= button.top - SLACK &&
    icon.bottom <= button.bottom + SLACK &&
    near(overlay.top - anchor.top, top) &&
    near(anchor.right - overlay.right, OVERLAY_INSET) &&
    near(button.right, overlay.right) &&
    near(button.top - overlay.top, index * (BUTTON_SIZE + BUTTON_GAP)) &&
    near(button.bottom - button.top, BUTTON_SIZE) &&
    (hinting ? width >= BUTTON_SIZE - SLACK && width <= MAX_WIDTH : near(width, BUTTON_SIZE))
  );
}

/**
 * 点击的那一下是不是鼠标真点在这个按钮上：浏览器派发的、不是键盘触发的（键盘触发的 detail 是 0），
 * 坐标落在按钮自己的框里，坐标处最上面的元素是按钮或它里面自己建的节点。
 * 只看坐标处的元素不够：页面能把按钮里的提示文字、图标或伪元素撑成铺满视口的透明层，点哪都算点在按钮上。
 */
export function pointedAt(
  event: Pick<MouseEvent, "isTrusted" | "detail" | "clientX" | "clientY">,
  box: Box,
  own: (node: Element) => boolean,
  hit: (x: number, y: number) => Element | null,
): boolean {
  if (!event.isTrusted || event.detail < 1) return false;
  const { clientX: x, clientY: y } = event;
  if (x < box.left - 1 || x > box.right + 1 || y < box.top - 1 || y > box.bottom + 1) return false;
  const target = hit(x, y);
  return target !== null && own(target);
}
