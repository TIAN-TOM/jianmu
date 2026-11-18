// 卡片周围的页面是浅色还是深色：从给的节点往上找第一个有底色的，按亮度分；认不出时是 null。
import assert from "node:assert/strict";
import { test } from "node:test";
import { pageTone, tintOf } from "../../../src/content/page-tone.ts";

interface Node {
  readonly background: string;
  readonly parentElement: Node | null;
}

/** 从里到外一串节点，各自的底色。 */
function chain(...backgrounds: string[]): Node | null {
  let outer: Node | null = null;
  for (const background of [...backgrounds].reverse()) outer = { background, parentElement: outer };
  return outer;
}
const toneOf = (...backgrounds: string[]) => pageTone(chain(...backgrounds), (node) => node.background);

test("底色按亮度分浅色深色：白、浅灰是浅色，近黑、深灰是深色", () => {
  assert.equal(toneOf("rgb(255, 255, 255)"), "light");
  assert.equal(toneOf("rgb(241, 242, 243)"), "light");
  assert.equal(toneOf("rgb(23, 24, 26)"), "dark");
  assert.equal(toneOf("rgb(60, 60, 64)"), "dark");
});

test("透明的底色不算，接着往上找；一路都没有底色是 null", () => {
  assert.equal(toneOf("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"), "light", "透明的黑不是深色");
  assert.equal(toneOf("rgba(255, 255, 255, 0.2)", "rgb(20, 20, 20)"), "dark", "太透的浅色盖不住下面的深色");
  assert.equal(toneOf("rgba(20, 20, 20, 0.9)", "rgb(255, 255, 255)"), "dark", "够不透明的就按它");
  assert.equal(toneOf("rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"), null);
  assert.equal(pageTone(null, () => "rgb(0, 0, 0)"), null);
});

test("认不出的写法跳过，不当成黑色", () => {
  assert.equal(toneOf("oklch(0.2 0.02 250)", "rgb(255, 255, 255)"), "light");
  assert.equal(toneOf("", "transparent"), null);
  assert.equal(tintOf("rgb(a, b, c)"), null);
});

test("几种算出来的写法都认：带逗号的、空格加斜线的、带百分比不透明度的、srgb 的", () => {
  assert.deepEqual(tintOf("rgb(0, 0, 0)"), { luminance: 0, alpha: 1 });
  assert.equal(tintOf("rgba(255, 255, 255, 0.5)")?.alpha, 0.5);
  assert.equal(tintOf("rgb(255 255 255 / 50%)")?.alpha, 0.5);
  const white = tintOf("color(srgb 1 1 1)");
  assert.ok(white && Math.abs(white.luminance - 1) < 1e-9 && white.alpha === 1);
  assert.equal(tintOf("color(srgb 0.1 0.1 0.1 / 0.25)")?.alpha, 0.25);
});
