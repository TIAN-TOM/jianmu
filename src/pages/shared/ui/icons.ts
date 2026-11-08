// 界面图标和判断标记的绘制数据。图标在 16px 网格上，1.5px 线宽、圆头圆角、跟随文字颜色；
// 判断标记在 14px 网格上。只存几何数据，组件逐个画成 SVG 元素，不拼标记文本。
import type { MarkShape } from "./verdict.ts";

export type IconPart =
  | { readonly kind: "path"; readonly d: string; readonly solid?: boolean; readonly weight?: number }
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number; readonly solid?: boolean; readonly dash?: number }
  | { readonly kind: "rect"; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rx: number };

export const ICON_GRID = 16;
export const MARK_GRID = 14;

const path = (d: string, extra: { readonly solid?: boolean; readonly weight?: number } = {}): IconPart => ({ kind: "path", d, ...extra });
const circle = (cx: number, cy: number, r: number, extra: { readonly solid?: boolean; readonly dash?: number } = {}): IconPart => ({
  kind: "circle",
  cx,
  cy,
  r,
  ...extra,
});
const rect = (x: number, y: number, width: number, height: number, rx: number): IconPart => ({ kind: "rect", x, y, width, height, rx });

export const ICONS = Object.freeze({
  note: [
    path("M8.6 2.4H4.1c-.6 0-1.1.5-1.1 1.1v8.9c0 .6.5 1.1 1.1 1.1h6.2c.6 0 1.1-.5 1.1-1.1V7.9"),
    path("M11.2 2.2a1.4 1.4 0 0 1 2 2L9.1 8.3l-2.5.5.5-2.5Z"),
  ],
  copy: [rect(5.6, 5.6, 8, 8, 1.6), path("M10.4 3.6v-.8c0-.9-.7-1.6-1.6-1.6H3.6c-.9 0-1.6.7-1.6 1.6v5.2c0 .9.7 1.6 1.6 1.6h.8")],
  trash: [path("M2.8 4.3h10.4M6.3 4.3V3.1c0-.4.3-.8.8-.8h1.8c.5 0 .8.4.8.8v1.2M4.2 4.3v8.2c0 .6.5 1.2 1.1 1.2h5.4c.6 0 1.1-.6 1.1-1.2V4.3")],
  external: [path("M9.5 2.5h4v4M13.5 2.5 8 8"), path("M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3")],
  search: [circle(7, 7, 4.75), path("m10.6 10.6 3.9 3.9")],
  /** 回到当前句 */
  target: [circle(8, 8, 4.25), circle(8, 8, 0.5, { solid: true }), path("M8 1.25v2M8 12.75v2M1.25 8h2M12.75 8h2")],
  task: [circle(8, 8, 5.75), path("M8 4.8V8l2.2 1.4")],
  settings: [path("M2 4.5h6.1M13.9 4.5H14"), circle(11, 4.5, 1.9), path("M2 11.5h2.1M9.9 11.5H14"), circle(6, 11.5, 1.9)],
  edit: [path("M10.9 2.6a1.5 1.5 0 0 1 2.1 2.1l-8 8-2.8.7.7-2.8Z")],
  more: [path("M3.5 8h.01M8 8h.01M12.5 8h.01", { weight: 2.2 })],
  chevron: [path("m4 6 4 4 4-4")],
  close: [path("m3.5 3.5 9 9M12.5 3.5l-9 9")],
  back: [path("M10 3 5 8l5 5")],
  check: [path("m3 8.5 3.2 3.2L13 5")],
  alert: [path("M8 2.5 14 13H2Z"), path("M8 7v2.6M8 11.3v.1")],
} satisfies Record<string, readonly IconPart[]>);

export type IconName = keyof typeof ICONS;

/** 判断标记：实心圆、半实心圆、空心圆、虚线圆、圆角方块。 */
export const MARK_PARTS = Object.freeze({
  go: [circle(7, 7, 6, { solid: true })],
  fair: [circle(7, 7, 5.25), path("M7 1.75a5.25 5.25 0 0 1 0 10.5Z", { solid: true })],
  skip: [circle(7, 7, 5.25)],
  unknown: [circle(7, 7, 5.25, { dash: 2.2 })],
  square: [rect(2, 2, 10, 10, 2.5)],
} satisfies Record<MarkShape, readonly IconPart[]>);
