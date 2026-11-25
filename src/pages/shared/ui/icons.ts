// 界面图标和判断标记的绘制数据。图标在 16px 网格上，1.5px 线宽、圆头圆角、跟随文字颜色；
// 判断标记分三套画法，各在自己的网格上，由主题样式表决定显示哪一套。只存几何数据，组件逐个画成 SVG 元素，不拼标记文本。
import type { MarkShape } from "./verdict.ts";

export type IconPart =
  | { readonly kind: "path"; readonly d: string; readonly solid?: boolean; readonly weight?: number }
  | { readonly kind: "circle"; readonly cx: number; readonly cy: number; readonly r: number; readonly solid?: boolean; readonly dash?: number }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
      readonly solid?: boolean;
      /** 空着的格子：颜色由样式表给，不跟文字颜色。 */
      readonly off?: boolean;
      readonly dash?: number;
    };

export const ICON_GRID = 16;

const path = (d: string, extra: { readonly solid?: boolean; readonly weight?: number } = {}): IconPart => ({ kind: "path", d, ...extra });
const circle = (cx: number, cy: number, r: number, extra: { readonly solid?: boolean; readonly dash?: number } = {}): IconPart => ({
  kind: "circle",
  cx,
  cy,
  r,
  ...extra,
});
const rect = (x: number, y: number, width: number, height: number, rx: number, extra: { readonly solid?: boolean; readonly off?: boolean; readonly dash?: number } = {}): IconPart => ({
  kind: "rect",
  x,
  y,
  width,
  height,
  rx,
  ...extra,
});

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
  /** 重点章节：从这里看 */
  play: [path("M3.5 2.2 13.5 8l-10 5.8Z", { solid: true })],
} satisfies Record<string, readonly IconPart[]>);

export type IconName = keyof typeof ICONS;

export type MarkSet = "meter" | "grade" | "player";

export interface MarkDrawing {
  /** 网格的宽和高。 */
  readonly width: number;
  readonly height: number;
  /** 不实心的部分的线宽。 */
  readonly stroke: number;
  readonly parts: readonly IconPart[];
}

const meterCell = (index: number, filled: boolean): IconPart => rect(index * 14, 0, 12, 6, 1, filled ? { solid: true } : { off: true });
const meter = (filled: number): MarkDrawing => ({ width: 40, height: 6, stroke: 1, parts: [0, 1, 2].map((index) => meterCell(index, index < filled)) });
const grade = (parts: readonly IconPart[], width = 22): MarkDrawing => ({ width, height: 18, stroke: 2.2, parts });
const player = (parts: readonly IconPart[]): MarkDrawing => ({ width: 24, height: 24, stroke: 2, parts });

/**
 * 判断标记的三套画法。四档之外，旧版的「看概览就够」每套都画成和四档不同类的东西：刻度和批改记号是一个空方框，播放器记号是停止键。
 *   meter：三格刻度，推荐看三格、可以看两格、可跳过一格，信息不足是虚线空框；
 *   grade：批改记号，推荐看两道勾、可以看一道勾、可跳过一道横线，信息不足一个问号；
 *   player：播放器记号，推荐看是播放、可以看是快进、可跳过是下一个，信息不足是带圈的问号。
 */
export const MARK_SETS = Object.freeze({
  meter: {
    go: meter(3),
    fair: meter(2),
    skip: meter(1),
    unknown: { width: 40, height: 6, stroke: 1, parts: [rect(0.5, 0.5, 39, 5, 1, { dash: 2 })] },
    square: { width: 40, height: 6, stroke: 1, parts: [rect(0.5, 0.5, 5, 5, 1)] },
  },
  grade: {
    go: grade([path("M2 10.5l4 4L14 4"), path("M13 10.5l4 4L27 3")], 29),
    fair: grade([path("M3 10.5l4.5 4.5L19 3")]),
    skip: grade([path("M4 9.5h14")]),
    unknown: grade([path("M7.5 6.5a3.5 3.5 0 1 1 4.7 3.3c-.8.3-1.2.9-1.2 1.8"), path("M11 15.2h.01")]),
    square: grade([rect(5.5, 4, 11, 10, 1.5)]),
  },
  player: {
    go: player([path("M5 4l15 8-15 8z", { solid: true })]),
    fair: player([path("M2 5l9 7-9 7z", { solid: true }), path("M12 5l9 7-9 7z", { solid: true })]),
    skip: player([path("M3 5l10 7-10 7z", { solid: true }), rect(15, 5, 3, 14, 0, { solid: true })]),
    unknown: player([circle(12, 12, 9), path("M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5"), path("M12 17h.01")]),
    square: player([rect(6, 6, 12, 12, 1.5, { solid: true })]),
  },
} satisfies Record<MarkSet, Record<MarkShape, MarkDrawing>>);

/** 三套画法，组件按这个顺序画。 */
export const MARK_SET_NAMES: readonly MarkSet[] = Object.freeze(["meter", "grade", "player"]);
