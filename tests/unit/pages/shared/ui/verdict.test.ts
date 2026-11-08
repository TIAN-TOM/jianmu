// 判断标记和依据行：每一档都有自己的形状，形状互不相同；认不出的档位不画标记；依据按实际来源写。
import assert from "node:assert/strict";
import { test } from "node:test";
import { VERDICT_LABELS } from "../../../../../src/core/ai/verdict.ts";
import { MARK_PARTS } from "../../../../../src/pages/shared/ui/icons.ts";
import { basisText, MARK_SHAPES, markOf } from "../../../../../src/pages/shared/ui/verdict.ts";

test("现有的每一档判断都有标记，形状互不相同；「看概览就够」是方块，不混进圆形那几档", () => {
  const shapes = VERDICT_LABELS.map((label) => markOf(label));
  assert.ok(shapes.every((shape) => shape !== null), "每一档都有标记");
  assert.equal(new Set(shapes).size, VERDICT_LABELS.length, "形状互不相同");
  assert.deepEqual(
    Object.fromEntries(VERDICT_LABELS.map((label) => [label, markOf(label)])),
    { 值得看完整视频: "go", 看概览就够: "square", 可以跳过: "skip", 信息不足: "unknown" },
  );
});

test("认不出的档位（空的、模型自创的、对象原型上的名字）不画标记；前后空白不影响", () => {
  for (const label of ["", "还行", "constructor", "toString", null, undefined]) assert.equal(markOf(label), null, String(label));
  assert.equal(markOf(" 可以跳过 "), "skip");
});

test("五种标记形状都有绘制数据，没有多出来的", () => {
  assert.deepEqual(Object.keys(MARK_PARTS).sort(), [...MARK_SHAPES].sort());
  assert.equal(MARK_SHAPES.length, 5);
});

test("依据行按四种依据写", () => {
  assert.equal(basisText("transcript"), "依据字幕");
  assert.equal(basisText("official-summary"), "依据 B 站官方总结，没有通读字幕");
  assert.equal(basisText("title-description"), "依据标题和简介");
  assert.equal(basisText("legacy-unknown"), "依据未知（旧版）");
});
