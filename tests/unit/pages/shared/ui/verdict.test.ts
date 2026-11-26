// 判断标记和依据行：每一档都有自己的形状，形状互不相同；认不出的档位不画标记；依据按实际来源写。
import assert from "node:assert/strict";
import { test } from "node:test";
import { LEGACY_VERDICT, VERDICT_LABELS } from "../../../../../src/core/ai/verdict.ts";
import { MARK_SET_NAMES, MARK_SETS } from "../../../../../src/pages/shared/ui/icons.ts";
import { basisText, labelOf, MARK_SHAPES, markOf, staleOverviewMarks } from "../../../../../src/pages/shared/ui/verdict.ts";

test("四档和旧判断都有标记，形状互不相同；旧版的「看概览就够」单独一种形状，不混进四档", () => {
  const labels = [...VERDICT_LABELS, LEGACY_VERDICT];
  const shapes = labels.map((label) => markOf(label));
  assert.ok(shapes.every((shape) => shape !== null), "每一档都有标记");
  assert.equal(new Set(shapes).size, labels.length, "形状互不相同");
  assert.deepEqual(
    Object.fromEntries(labels.map((label) => [label, markOf(label)])),
    { 推荐看: "go", 可以看: "fair", 可跳过: "skip", 信息不足: "unknown", 看概览就够: "square" },
  );
});

test("存着的旧档位按新名字显示和配标记：值得看完整视频是推荐看，可以跳过是可跳过", () => {
  assert.equal(markOf("值得看完整视频"), "go");
  assert.equal(labelOf("值得看完整视频"), "推荐看");
  assert.equal(markOf(" 可以跳过 "), "skip");
  assert.equal(labelOf("可以跳过"), "可跳过");
  assert.equal(labelOf("看概览就够"), "看概览就够");
  assert.equal(labelOf("还行"), "");
});

test("认不出的档位（空的、模型自创的、对象原型上的名字）不画标记；前后空白不影响", () => {
  for (const label of ["", "还行", "constructor", "toString", "__proto__", null, undefined]) {
    assert.equal(markOf(label), null, String(label));
    assert.equal(labelOf(label), "", String(label));
  }
  assert.equal(markOf(" 可跳过 "), "skip");
});

test("三套画法里五种标记形状都有绘制数据，没有多出来的；同一套里五种画得各不相同", () => {
  assert.equal(MARK_SHAPES.length, 5);
  assert.deepEqual(Object.keys(MARK_SETS).sort(), [...MARK_SET_NAMES].sort());
  for (const [set, shapes] of Object.entries(MARK_SETS)) {
    assert.deepEqual(Object.keys(shapes).sort(), [...MARK_SHAPES].sort(), set);
    const drawn = Object.values(shapes).map((drawing) => JSON.stringify(drawing));
    assert.equal(new Set(drawn).size, MARK_SHAPES.length, `${set}：五种画得各不相同`);
  }
});

test("依据行按四种依据写", () => {
  assert.equal(basisText("transcript"), "依据字幕");
  assert.equal(basisText("official-summary"), "依据 B 站官方总结，没有通读字幕");
  assert.equal(basisText("title-description"), "依据标题和简介");
  assert.equal(basisText("legacy-unknown"), "依据未知（旧版）");
});

test("基于旧字幕标在哪：结论块标结论自己的，章节基于旧字幕而结论块没标时单独标一行，同一件事不标两遍", () => {
  const both = { chapters: "old", verdict: "old" };
  assert.deepEqual(staleOverviewMarks(both, "new", true), { verdict: true, chapters: false }, "两处都旧：标在结论块里就够");
  assert.deepEqual(staleOverviewMarks(both, "new", false), { verdict: false, chapters: true }, "结论还没摆出来：标在章节上");
  assert.deepEqual(staleOverviewMarks({ chapters: "old" }, "new", true), { verdict: false, chapters: true }, "结论依据官方总结，章节依据旧字幕");
  assert.deepEqual(staleOverviewMarks({ chapters: "new", verdict: "old" }, "new", true), { verdict: true, chapters: false }, "章节重新生成了、结论没写成");
  assert.deepEqual(staleOverviewMarks(both, "old", true), { verdict: false, chapters: false });
  assert.deepEqual(staleOverviewMarks(both, null, true), { verdict: false, chapters: false }, "现在没读到字幕时不标");
  assert.deepEqual(staleOverviewMarks(undefined, "new", true), { verdict: false, chapters: false });
});

test("繁体界面：档位显示繁体名，旧版改了名的按新名字，标记照旧，认不出的档位是空串", () => {
  assert.deepEqual(
    [...VERDICT_LABELS, LEGACY_VERDICT, "值得看完整视频", "可以跳过"].map((label) => labelOf(label, "zh-Hant")),
    ["推薦看", "可以看", "可跳過", "資訊不足", "看概覽就夠", "推薦看", "可跳過"],
  );
  assert.equal(labelOf("还行", "zh-Hant"), "");
  assert.equal(markOf("可跳过"), "skip");
});
