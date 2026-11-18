// 悬停图标的防点击劫持：点击时的样子核对和「鼠标真点在按钮上」的核对。
// 被劫持的页面能用 !important 的样式表把图标改成透明、加滤镜、裁掉、变形、混合掉、换定位，也能把焦点挪到图标上等用户按键。
import assert from "node:assert/strict";
import { test } from "node:test";
import { alphaOf, keepsLook, pointedAt, type Look } from "../../../src/content/hover-icons.ts";

const BUTTON: Look = {
  opacity: 1,
  visibility: "visible",
  position: "static",
  filter: "none",
  clipPath: "none",
  transform: "none",
  blend: "normal",
  color: "rgb(255, 255, 255)",
  background: "rgba(0, 0, 0, 0.5)",
};
const OVERLAY: Look = { ...BUTTON, position: "absolute", color: "rgb(0, 0, 0)", background: "rgba(0, 0, 0, 0)" };

test("颜色的不透明度：rgb 是 1，rgba 取第四个，transparent 和认不出的按 0", () => {
  assert.equal(alphaOf("rgb(255, 255, 255)"), 1);
  assert.equal(alphaOf("rgba(0, 0, 0, 0.5)"), 0.5);
  assert.equal(alphaOf("rgb(0 0 0 / 40%)"), 0.4);
  assert.equal(alphaOf("transparent"), 0);
  assert.equal(alphaOf("color(srgb 1 1 1)"), 0);
});

test("自己注入的样子照常放行，按钮亮起来换成主题色也算", () => {
  assert.equal(keepsLook(BUTTON, BUTTON, "button"), true);
  assert.equal(keepsLook({ ...BUTTON, background: "rgba(42, 102, 100, 0.92)" }, BUTTON, "button"), true);
  assert.equal(keepsLook(OVERLAY, OVERLAY, "overlay"), true, "浮层本身没有底色");
  assert.equal(keepsLook({ ...BUTTON, visibility: "visible" }, { ...BUTTON, visibility: "hidden" }, "button"), true, "注入时播放器藏着");
});

test("被页面改过的样子一律不放行：透明、藏起来、滤镜、裁剪、变形、混合、换定位、字和底色透明", () => {
  const changed: readonly [string, Partial<Look>][] = [
    ["透明度", { opacity: 0.2 }],
    ["比注入时淡", { opacity: 0.7 }],
    ["藏起来", { visibility: "hidden" }],
    ["滤镜", { filter: "opacity(0)" }],
    ["裁剪", { clipPath: "inset(50%)" }],
    ["变形", { transform: "matrix(10, 0, 0, 10, 0, 0)" }],
    ["混合", { blend: "multiply" }],
    ["改成固定定位铺在播放器上", { position: "fixed" }],
    ["字透明", { color: "rgba(255, 255, 255, 0)" }],
    ["底色透明", { background: "rgba(0, 0, 0, 0)" }],
  ];
  for (const [label, patch] of changed) assert.equal(keepsLook({ ...BUTTON, ...patch }, BUTTON, "button"), false, label);
  assert.equal(keepsLook({ ...OVERLAY, filter: "opacity(0)" }, OVERLAY, "overlay"), false, "浮层加滤镜");
  assert.equal(keepsLook({ ...OVERLAY, position: "fixed" }, OVERLAY, "overlay"), false, "浮层换定位");
  assert.equal(keepsLook(null, BUTTON, "button"), false, "读不到样子");
});

test("只认鼠标真点在按钮上的那一下：脚本点的、键盘触发的、坐标落在别处的都不算", () => {
  const button = { contains: (node: unknown) => node === inner } as unknown as Element;
  const inner = {} as Element;
  const elsewhere = {} as Element;
  const at = (target: Element | null) => () => target;
  const click = { isTrusted: true, detail: 1, clientX: 10, clientY: 10 };
  assert.equal(pointedAt(click, button, at(button)), true);
  assert.equal(pointedAt(click, button, at(inner)), true, "点在图标里的图形上");
  assert.equal(pointedAt({ ...click, isTrusted: false }, button, at(button)), false, "脚本派发的");
  assert.equal(pointedAt({ ...click, detail: 0 }, button, at(button)), false, "按空格或回车触发的");
  assert.equal(pointedAt(click, button, at(elsewhere)), false, "坐标落在别的元素上");
  assert.equal(pointedAt(click, button, at(null)), false);
});
