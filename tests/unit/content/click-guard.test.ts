// 悬停图标的防点击劫持：点击时的样子核对、位置核对和「鼠标真点在按钮上」的核对。
// 被劫持的页面能用 !important 的样式表把图标改成透明、加滤镜、裁掉、遮住、变形、缩放、混合掉、换定位、挪位置、撑大，
// 能把按钮里的提示文字或图标撑成铺满视口的透明层，也能把焦点挪到图标上等用户按键；
// 还能只改真正画出来的东西（图标的线条、提示文字），或者借半透明的底色和后面的颜色合成出看不见的按钮。
import assert from "node:assert/strict";
import { test } from "node:test";
import { alphaOf, contrastOf, keepsLook, placedAsInjected, pointedAt, type Box, type Look } from "../../../src/content/click-guard.ts";
import { ACCENT_SWATCHES } from "../../../src/content/hover-icons.ts";

const PINNED: Look = {
  opacity: "1",
  visibility: "visible",
  display: "inline-flex",
  position: "static",
  filter: "none",
  clipPath: "none",
  mask: "none",
  transform: "none",
  translate: "none",
  scale: "none",
  rotate: "none",
  zoom: "1",
  blend: "normal",
  color: "rgb(255, 255, 255)",
  background: "rgba(0, 0, 0, 0.5)",
  backgroundImage: "none",
  backgroundClip: "border-box",
  border: "0px 0px 0px 0px",
  shadow: "none",
  stroke: "rgb(255, 255, 255)",
  strokeOpacity: "1",
  strokeWidth: "1.5px",
  strokeDash: "none",
};
const OVERLAY: Look = { ...PINNED, display: "flex", position: "absolute", background: "rgba(0, 0, 0, 0)" };
// 图标的线条和提示文字：颜色从按钮继承，自己没有底色。
const PATH: Look = { ...PINNED, display: "inline", background: "rgba(0, 0, 0, 0)" };
const LABEL: Look = { ...PINNED, display: "inline", background: "rgba(0, 0, 0, 0)" };
const REST = PINNED.background;
const hexRgb = (hex: string): string => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(", ");
// 五套主题亮起来时：标志色 0.92 透明度的底配这套的字色，线条和提示文字也是这个字色。
const LIT = Object.entries(ACCENT_SWATCHES).map(([theme, { fill, ink }]) => ({ theme, color: `rgb(${hexRgb(ink)})`, background: `rgba(${hexRgb(fill)}, 0.92)` }));

test("颜色：不透明度和最坏情况的对比度；认不出的格式、超出范围的分量按看不见", () => {
  assert.equal(alphaOf("rgb(255, 255, 255)"), 1);
  assert.equal(alphaOf("rgba(0, 0, 0, 0.5)"), 0.5);
  assert.equal(alphaOf("rgb(0 0 0 / 40%)"), 0.4);
  assert.equal(alphaOf("transparent"), 0);
  assert.equal(alphaOf("color(srgb 1 1 1)"), 0);
  // 半黑的底垫在纯白上合成出来最亮，白字在这时的对比度最低，大约 3.98:1。
  const rest = contrastOf("rgb(255, 255, 255)", "rgba(0, 0, 0, 0.5)");
  assert.ok(rest > 3.9 && rest < 4, `平时的半黑底白字 ${rest}`);
  assert.ok(contrastOf("rgb(255, 255, 255)", "rgb(0, 0, 0)") > 20, "不透明的底不看后面");
  assert.ok(contrastOf("rgb(255, 255, 255)", "rgba(211, 56, 44, 0.92)") >= 3, "主题色上的白字也够");
  assert.ok(contrastOf("rgb(15, 15, 15)", "rgba(255, 0, 51, 0.92)") >= 3, "红色标志色上的深色字也够");
  assert.equal(contrastOf("rgb(0, 0, 0)", "rgba(0, 0, 0, 0.5)"), 1, "黑底黑字");
  assert.ok(contrastOf("rgb(200, 200, 200)", "rgb(255, 255, 255)") < 3, "浅灰配白看不清");
  assert.equal(contrastOf("oklab(1 0 0)", "rgb(0, 0, 0)"), 0);
  assert.equal(contrastOf("rgb(255, 255, 255)", ""), 0, "没给底色");
  // 负分量会把比值的分母压小、算出虚高的对比度，超出范围的一律当认不出。
  assert.equal(contrastOf("rgb(255, 255, 255)", "rgb(-500, -500, -500)"), 0, "负分量");
  assert.equal(contrastOf("rgb(300, 300, 300)", "rgb(0, 0, 0)"), 0, "超过 255");
  assert.equal(alphaOf("rgba(0, 0, 0, 2)"), 0, "不透明度超过 1");
});

test("钉死的样子照常放行：按钮平时的底色、五套主题亮起来、浮层、图标、线条、挂着的提示文字", () => {
  assert.equal(keepsLook(PINNED, "button"), true);
  assert.equal(keepsLook(PATH, "path", REST), true, "平时的线条");
  for (const { theme, color, background } of LIT) {
    // 亮起来时带一圈外阴影。
    assert.equal(keepsLook({ ...PINNED, color, background, shadow: "rgba(0, 0, 0, 0.24) 0px 2px 8px 0px" }, "button"), true, theme);
    assert.equal(keepsLook({ ...PATH, stroke: color, color }, "path", background), true, `${theme} 的线条`);
    assert.equal(keepsLook({ ...LABEL, color, stroke: color }, "label", background), true, `${theme} 的提示文字`);
  }
  // 紧贴 3:1：不透明的黑底上 rgb(89, 89, 89) 是 2.998:1，rgb(90, 90, 90) 是 3.04:1。
  const black = "rgb(0, 0, 0)";
  assert.equal(keepsLook({ ...PINNED, background: black, color: "rgb(89, 89, 89)" }, "button"), false, "差一点不到 3:1");
  assert.equal(keepsLook({ ...PINNED, background: black, color: "rgb(90, 90, 90)" }, "button"), true, "刚过 3:1");
  assert.equal(keepsLook(OVERLAY, "overlay"), true);
  assert.equal(keepsLook({ ...PINNED, display: "inline" }, "icon"), true);
});

test("被页面改过的样子一律不放行，读不到也不放行", () => {
  const changed: readonly [string, Partial<Look>][] = [
    ["半透明", { opacity: "0.6" }],
    ["读不出透明度", { opacity: "" }],
    ["藏起来", { visibility: "hidden" }],
    ["滤镜", { filter: "opacity(0)" }],
    ["裁剪", { clipPath: "inset(50%)" }],
    ["遮罩", { mask: "linear-gradient(transparent, transparent)" }],
    ["变形", { transform: "matrix(10, 0, 0, 10, 0, 0)" }],
    ["单独的平移", { translate: "200px 100px" }],
    ["单独的缩放", { scale: "10" }],
    ["单独的旋转", { rotate: "180deg" }],
    ["缩放", { zoom: "5" }],
    ["混合", { blend: "multiply" }],
    ["改成固定定位", { position: "fixed" }],
    ["字透明", { color: "rgba(255, 255, 255, 0)" }],
    ["底色透明", { background: "rgba(0, 0, 0, 0)" }],
    ["黑底黑字", { color: "rgb(0, 0, 0)" }],
    ["白底浅灰字，字不透明但对比度不够", { color: "rgb(200, 200, 200)", background: "rgb(255, 255, 255)" }],
    ["不显示", { display: "none" }],
    // 后面是黑色时，四成白的底合成出来正好是这个灰。
    ["半透明白底配灰字", { background: "rgba(255, 255, 255, 0.4)", color: "rgb(102, 102, 102)" }],
    ["半透明黑底配灰字", { background: "rgba(0, 0, 0, 0.5)", color: "rgb(130, 130, 130)" }],
    ["底色上铺一层白", { backgroundImage: "linear-gradient(rgb(255, 255, 255), rgb(255, 255, 255))" }],
    ["底色上铺一张图", { backgroundImage: 'url("https://example.com/white.png")' }],
    ["底色只铺在字下面", { backgroundClip: "text" }],
    ["一圈白边框盖住底色", { border: "16px 16px 16px 16px" }],
    ["内阴影盖住底色", { shadow: "rgb(255, 255, 255) 0px 0px 0px 16px inset" }],
  ];
  for (const [label, patch] of changed) assert.equal(keepsLook({ ...PINNED, ...patch }, "button"), false, label);
  assert.equal(keepsLook({ ...OVERLAY, filter: "opacity(0)" }, "overlay"), false, "浮层加滤镜");
  assert.equal(keepsLook({ ...OVERLAY, position: "fixed" }, "overlay"), false, "浮层换定位");
  assert.equal(keepsLook({ ...PINNED, stroke: "rgba(255, 255, 255, 0)" }, "icon"), false, "图标描边透明");
  assert.equal(keepsLook({ ...PINNED, visibility: "hidden" }, "icon"), false, "图标藏起来");
  assert.equal(keepsLook({ ...PINNED, display: "none" }, "icon"), false, "图标不显示");
  assert.equal(keepsLook(null, "button"), false, "读不到样子");
});

test("页面直接改图标的线条：线条颜色和按钮底色过同一个对比度核对，藏起来、变细、虚线、透明都不放行", () => {
  const changed: readonly [string, Partial<Look>][] = [
    // 例如 svg { stroke: rgb(0, 0, 0) }，线条继承过来，和半黑的底分不出来。
    ["线条改成黑色", { stroke: "rgb(0, 0, 0)" }],
    ["线条透明", { stroke: "transparent" }],
    ["线条没有颜色", { stroke: "none" }],
    ["线条不透明度", { strokeOpacity: "0" }],
    ["线条藏起来", { visibility: "hidden" }],
    ["线条不显示", { display: "none" }],
    ["线条半透明", { opacity: "0" }],
    ["线条细到看不见", { strokeWidth: "0px" }],
    ["线条改成虚线", { strokeDash: "0px, 100px" }],
    ["线条加滤镜", { filter: "opacity(0)" }],
    ["线条挪出图标", { transform: "matrix(1, 0, 0, 1, 100, 0)" }],
  ];
  for (const [label, patch] of changed) assert.equal(keepsLook({ ...PATH, ...patch }, "path", REST), false, label);
  for (const { theme, background } of LIT) assert.equal(keepsLook({ ...PATH, stroke: background.replace("rgba", "rgb").replace(/, 0\.92\)$/, ")") }, "path", background), false, `${theme}：线条改成和底色一样`);
  assert.equal(keepsLook(PATH, "path"), false, "没给按钮底色");
  assert.equal(keepsLook(PATH, "path", "rgba(255, 255, 255, 0.4)"), false, "按钮底色被换成了半透明白");
});

test("挂着的提示文字：颜色和按钮底色过对比度核对，透明、藏起来都不放行", () => {
  const changed: readonly [string, Partial<Look>][] = [
    ["字透明", { color: "transparent" }],
    ["字和底一样黑", { color: "rgb(0, 0, 0)" }],
    ["藏起来", { visibility: "hidden" }],
    ["不显示", { display: "none" }],
    ["半透明", { opacity: "0.2" }],
  ];
  for (const [label, patch] of changed) assert.equal(keepsLook({ ...LABEL, ...patch }, "label", REST), false, label);
  assert.equal(keepsLook(LABEL, "label", REST), true);
});

const ANCHOR: Box = { left: 0, top: 100, right: 800, bottom: 550 };
const OVERLAY_BOX: Box = { left: 756, top: 112, right: 788, bottom: 184 };
const first: Box = { left: 756, top: 112, right: 788, bottom: 144 };
const second: Box = { left: 756, top: 152, right: 788, bottom: 184 };
// 图标在按钮正中，16 见方；挂着提示时按钮往左变宽，图标跟着在最左边。
const iconIn = (button: Box, hinting = false): Box => {
  const left = hinting ? button.left + 8 : (button.left + button.right) / 2 - 8;
  const top = (button.top + button.bottom) / 2 - 8;
  return { left, top, right: left + 16, bottom: top + 16 };
};

test("位置和大小：贴着锚点右上角、从上往下排、32 见方；挂着提示时可以变宽", () => {
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay: OVERLAY_BOX, button: first, icon: iconIn(first), index: 0, hinting: false, top: 12 }), true);
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay: OVERLAY_BOX, button: second, icon: iconIn(second), index: 1, hinting: false, top: 12 }), true);
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay: OVERLAY_BOX, button: { ...first, left: 640 }, icon: iconIn({ ...first, left: 640 }, true), index: 0, hinting: true, top: 12 }), true, "挂着提示");
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay: OVERLAY_BOX, button: { ...first, top: 112.5, bottom: 144.5 }, icon: iconIn({ ...first, top: 112.5, bottom: 144.5 }), index: 0, hinting: false, top: 12 }), true, "小数像素");
});

test("图标被缩没、撑大、挪出按钮的不放行", () => {
  const icon = iconIn(first);
  const moved: readonly [string, Box][] = [
    ["缩成一个点", { ...icon, right: icon.left, bottom: icon.top }],
    ["撑大", { ...icon, right: icon.left + 32 }],
    ["挪出按钮", { left: icon.left - 500, top: icon.top, right: icon.right - 500, bottom: icon.bottom }],
    ["往下挪出按钮", { ...icon, top: icon.top + 40, bottom: icon.bottom + 40 }],
  ];
  for (const [label, box] of moved) assert.equal(placedAsInjected({ anchor: ANCHOR, overlay: OVERLAY_BOX, button: first, icon: box, index: 0, hinting: false, top: 12 }), false, label);
});

test("被挪走、撑大的都不放行", () => {
  const moved: readonly [string, Box, Box, number, boolean][] = [
    ["浮层挪到视频中间", { left: 384, top: 300, right: 416, bottom: 372 }, { left: 384, top: 300, right: 416, bottom: 332 }, 0, false],
    ["按钮用 margin 挪开", OVERLAY_BOX, { left: 556, top: 312, right: 588, bottom: 344 }, 0, false],
    ["按钮撑成一块热区", OVERLAY_BOX, { left: 468, top: 112, right: 788, bottom: 208 }, 0, false],
    ["没挂提示却变宽", OVERLAY_BOX, { ...first, left: 640 }, 0, false],
    ["挂着提示也不能宽过一行字", OVERLAY_BOX, { ...first, left: 400 }, 0, true],
    ["第二个按钮排在第一个的位置", OVERLAY_BOX, first, 1, false],
  ];
  for (const [label, overlay, button, index, hinting] of moved) assert.equal(placedAsInjected({ anchor: ANCHOR, overlay, button, icon: iconIn(button, hinting), index, hinting, top: 12 }), false, label);
});

test("站点给了离上沿的距离：照它核对，挪回默认位置的不放行", () => {
  const lowered = (box: Box): Box => ({ ...box, top: box.top + 38, bottom: box.bottom + 38 });
  const overlay = lowered(OVERLAY_BOX);
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay, button: lowered(first), icon: iconIn(lowered(first)), index: 0, hinting: false, top: 50 }), true);
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay, button: lowered(second), icon: iconIn(lowered(second)), index: 1, hinting: false, top: 50 }), true);
  assert.equal(placedAsInjected({ anchor: ANCHOR, overlay: OVERLAY_BOX, button: first, icon: iconIn(first), index: 0, hinting: false, top: 50 }), false, "还在默认位置");
});

test("只认鼠标真点在按钮框里、点在自己建的节点上：脚本点的、键盘触发的、点在框外的、点在别的元素上的都不算", () => {
  const button = {} as Element;
  const inner = {} as Element;
  const elsewhere = {} as Element;
  const own = (node: Element): boolean => node === button || node === inner;
  const at = (target: Element | null) => () => target;
  const click = { isTrusted: true, detail: 1, clientX: 770, clientY: 128 };
  assert.equal(pointedAt(click, first, own, at(button)), true);
  assert.equal(pointedAt(click, first, own, at(inner)), true, "点在图标的线条上");
  assert.equal(pointedAt({ ...click, clientX: 755.5 }, first, own, at(button)), true, "贴边一像素");
  assert.equal(pointedAt({ ...click, isTrusted: false }, first, own, at(button)), false, "脚本派发的");
  assert.equal(pointedAt({ ...click, detail: 0 }, first, own, at(button)), false, "按空格或回车触发的");
  assert.equal(pointedAt({ ...click, clientX: 400, clientY: 300 }, first, own, at(inner)), false, "提示文字撑满了视口，点在视频中间");
  assert.equal(pointedAt(click, first, own, at(elsewhere)), false, "坐标处是别的元素");
  assert.equal(pointedAt(click, first, own, at(null)), false);
});
