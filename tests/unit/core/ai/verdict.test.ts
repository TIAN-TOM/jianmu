import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasAnalysisContent,
  hasOfficialSummaryContent,
  officialVerdictInputs,
  validateVerdict,
  VERDICT_LABELS,
  verdictInputs,
} from "../../../../src/core/ai/verdict.ts";

test("结论输入把章节和金句压成一行一条", () => {
  const { chaptersText, quotesText } = verdictInputs({
    chapters: [
      { timestamp: "0:00", title: "开场", summary: "讲了背景" },
      { timestamp: "5:10", title: "方法", summary: "" },
    ],
    keyQuotes: [{ timestamp: "2:30", quote: "一句金句" }],
  });
  assert.equal(chaptersText, "[0:00] 开场：讲了背景\n[5:10] 方法");
  assert.equal(quotesText, "[2:30] 一句金句");
  assert.equal(verdictInputs({ chapters: [] }).quotesText, "（无）");
});

test("结论只认三档判断，没有 summary 就当没生成", () => {
  assert.deepEqual(validateVerdict({ summary: " 讲了 A ", value: "B", verdict: "可以跳过", reason: "C" }), {
    summary: "讲了 A",
    value: "B",
    verdict: "可以跳过",
    reason: "C",
  });
  const invented = validateVerdict({ summary: "讲了 A", verdict: "还行", reason: "随便" });
  assert.equal(invented?.verdict, "", "模型自创的档位不显示");
  assert.equal(invented?.reason, "", "没有档位时理由也没有意义");
  assert.equal(validateVerdict({ verdict: "可以跳过" }), null);
  assert.equal(validateVerdict(null), null);
  assert.equal(validateVerdict({ summary: "字".repeat(500) })?.summary.length, 200);
});

test("结论输入带上覆盖情况：完整时说明覆盖全片，缺块时逐段列出缺失时段", () => {
  const analysis = { chapters: [{ timestamp: "0:00", title: "开场" }], keyQuotes: [] };
  assert.equal(verdictInputs(analysis).coverageNote, "章节摘要和金句覆盖了全片。");
  const note = verdictInputs(analysis, {
    failures: [
      { index: 1, startSeconds: 600, endSeconds: 1170, reason: "超时" },
      { index: 3, startSeconds: 1800, endSeconds: 2400 },
    ],
  }).coverageNote;
  assert.match(note, /^不完整/);
  assert.ok(note.includes("10:00–19:30"), note);
  assert.ok(note.includes("30:00–40:00"), note);
});

test("用官方总结写结论的输入：全片摘要打头，提纲每段一行，没有金句并注明来源", () => {
  const inputs = officialVerdictInputs({
    summary: " 全片在讲 A ",
    outline: [
      { title: "第一段", timestamp: 0, points: [{ content: "要点一" }, { content: " " }, { content: "要点二" }] },
      { title: "", timestamp: 125, points: [{ content: "只有要点" }] },
      { title: "没有时间", timestamp: null, points: [] },
      { title: "", timestamp: 300, points: [] },
    ],
  });
  assert.equal(
    inputs.chaptersText,
    "全片概述：全片在讲 A\n[0:00] 第一段：要点一；要点二\n[2:05] （这一段没有标题）：只有要点\n没有时间",
  );
  assert.equal(inputs.quotesText, "（无）");
  assert.match(inputs.coverageNote, /^覆盖全片/);
  assert.match(inputs.coverageNote, /B站官方 AI 总结/);
  assert.equal(officialVerdictInputs({ outline: [] }).chaptersText, "");
});

test("只有结论、没有章节和金句的概览不算有内容；官方总结要有摘要或提纲才算", () => {
  assert.equal(hasAnalysisContent(null), false);
  assert.equal(hasAnalysisContent({ chapters: [], keyQuotes: [], verdict: { summary: "x" } }), false);
  assert.equal(hasAnalysisContent({ chapters: [{ title: "章" }] }), true);
  assert.equal(hasAnalysisContent({ chapters: [], keyQuotes: [{ quote: "金句" }] }), true);
  assert.equal(hasOfficialSummaryContent({ status: "none", summary: "", outline: [] }), false);
  assert.equal(hasOfficialSummaryContent({ summary: "有摘要" }), true);
  assert.equal(hasOfficialSummaryContent({ outline: [{ title: "段" }] }), true);
});

test("结论认「信息不足」一档；概览缺块时标成不完整", () => {
  assert.ok(VERDICT_LABELS.includes("信息不足"));
  const unsure = validateVerdict({ summary: "讲了前半", verdict: "信息不足", reason: "后半缺失" }, { incomplete: true });
  assert.equal(unsure?.verdict, "信息不足");
  assert.equal(unsure?.reason, "后半缺失");
  assert.equal(unsure?.incomplete, true);
  assert.equal(
    validateVerdict({ summary: "讲了 A", verdict: "可以跳过" })?.incomplete,
    undefined,
    "完整概览的结论不带不完整标记",
  );
});

test("缺块时段的起止取整到秒，起点缺失按 0 算，终点缺失按起点算", () => {
  const note = verdictInputs(
    { chapters: [] },
    {
      failures: [
        { startSeconds: 12.3, endSeconds: 30.2 },
        { startSeconds: 0, endSeconds: 30 },
        { endSeconds: 45 },
        { startSeconds: 60 },
      ],
    },
  ).coverageNote;
  assert.equal(
    note,
    "不完整。以下时间段生成失败，章节摘要和金句里没有这几段的内容：0:12–0:30、0:00–0:30、0:00–0:45、1:00–1:00。",
  );
});

test("结论输入去掉章节摘要的首尾空白，只剩空白时不带冒号", () => {
  const { chaptersText } = verdictInputs({
    chapters: [
      { timestamp: "0:00", title: "开场", summary: "   " },
      { timestamp: "1:00", title: "方法", summary: " 讲了步骤 " },
    ],
  });
  assert.equal(chaptersText, "[0:00] 开场\n[1:00] 方法：讲了步骤");
});

test("官方总结只有空白时不算有内容；提纲里只有空白标题、又没有要点的段落跳过", () => {
  assert.equal(hasOfficialSummaryContent({ summary: "   " }), false);
  const { chaptersText } = officialVerdictInputs({
    outline: [
      { title: "  ", timestamp: 10, points: [] },
      { title: " 第一段 ", timestamp: 0, points: [] },
    ],
  });
  assert.equal(chaptersText, "[0:00] 第一段");
});

test("结论的判断档位去掉首尾空白再比对，价值和理由超过 120 字截断", () => {
  const verdict = validateVerdict({
    summary: "讲了 A",
    value: "值".repeat(121),
    verdict: " 可以跳过 ",
    reason: "因".repeat(121),
  });
  assert.equal(verdict?.verdict, "可以跳过");
  assert.equal(verdict?.value.length, 120);
  assert.equal(verdict?.reason.length, 120);
});
