// 判断色带和依据行。
import assert from "node:assert/strict";
import { test } from "node:test";
import { bandOf, basisText, staleOverviewMarks } from "../../../../../src/pages/shared/ui/verdict.ts";

test("五星和四星共用推荐色带，一星和二星共用可跳过色带，信息不足单独显示", () => {
  assert.deepEqual(([5, 4, 3, 2, 1, "信息不足", ""] as const).map(bandOf), ["go", "go", "fair", "skip", "skip", "unknown", undefined]);
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
