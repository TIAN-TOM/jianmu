import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasAnalysisContent,
  keyChapterStarts,
  TRANSLATED_TITLE_MAX,
  translatedTitleOf,
  validKeyStarts,
  hasOfficialSummaryContent,
  officialVerdictInputs,
  validateVerdict,
  VERDICT_STARS,
  verdictLabelOf,
  verdictInputs,
} from "../../../../src/core/ai/verdict.ts";
import { startSecondsOf } from "../../../../src/core/transcript/segment.ts";

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

test("模型直接给一到五颗星，没有 summary 就当没生成", () => {
  for (const stars of [1, 2, 3, 4, 5]) {
    for (const raw of [stars, String(stars), ` ${stars}\n`]) {
      assert.deepEqual(validateVerdict({ summary: " 讲了 A ", value: "B", verdict: raw, reason: "C" }),
        { summary: "讲了 A", value: "B", verdict: stars, reason: "C" });
    }
  }
  const incomplete = { summary: "讲了 A", value: "B", reason: "C" };
  for (const invalid of [0, 6, 3.5, -1, "0", "6", "3.5", "03", "+3", "3e0", "4星", "4 stars", "四星", "推荐看", "还行", null, true, [4], {}, undefined]) {
    assert.deepEqual(validateVerdict({ ...incomplete, verdict: invalid }),
      { summary: "讲了 A", value: "B", reason: "", verdict: "" }, String(invalid));
  }
  assert.equal(validateVerdict({ verdict: 1 }), null);
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

test("结论可明确标为「信息不足」，概览缺块时标成不完整", () => {
  const unsure = validateVerdict({ summary: "讲了前半", verdict: "信息不足", reason: "后半缺失" }, { incomplete: true });
  assert.equal(unsure?.verdict, "信息不足");
  assert.equal(unsure?.reason, "后半缺失");
  assert.equal(unsure?.incomplete, true);
  assert.equal(
    validateVerdict({ summary: "讲了 A", verdict: 1 })?.incomplete,
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

test("结论的价值和理由超过 120 字截断", () => {
  const verdict = validateVerdict({
    summary: "讲了 A",
    value: "值".repeat(121),
    verdict: 1,
    reason: "因".repeat(121),
  });
  assert.equal(verdict?.verdict, 1);
  assert.equal(verdict?.value.length, 120);
  assert.equal(verdict?.reason.length, 120);
});

test("时间点规范成整秒：认方括号、分秒、时分秒和秒数，认不出的不算", () => {
  assert.equal(startSecondsOf("[2:30]"), 150);
  assert.equal(startSecondsOf(" 75:05 "), 4505);
  assert.equal(startSecondsOf("1:02:03"), 3723);
  assert.equal(startSecondsOf("0:00"), 0);
  assert.equal(startSecondsOf("150"), 150);
  assert.equal(startSecondsOf(150.9), 150);
  for (const bad of ["2:61", "1:60:00", "两分半", "", "-5", -5, Number.NaN, null, undefined, {}]) {
    assert.equal(startSecondsOf(bad), null, String(bad));
  }
});

test("重点章节：精确对上现有章节才留，去重，最多三个，按时间先后，允许第 0 秒", () => {
  const starts = [0, 150, 300, 450, 600];
  assert.deepEqual(validKeyStarts(["5:00", "0:00"], starts), [0, 300]);
  assert.deepEqual(validKeyStarts(["2:30", "[2:30]", 150], starts), [150], "同一章写法不同也算重复");
  assert.deepEqual(validKeyStarts(["10:00", "7:30", "5:00", "2:30"], starts), [300, 450, 600], "超过三个时留先给的三个");
  assert.deepEqual(validKeyStarts(["2:31", "9:99", "开头", null], starts), [], "对不上的、格式错的都丢");
  assert.deepEqual(validKeyStarts(["2:31", "2:30"], starts), [150], "坏的不占三个的名额");
  assert.deepEqual(validKeyStarts("2:30", starts), [], "不是数组按没有");
  assert.deepEqual(validKeyStarts(["2:30"], []), []);
});

test("结论带重点章节：只在给了章节时收，坏了只丢重点、结论照存", () => {
  const raw = { summary: "讲了 A", value: "B", verdict: 3, reason: "C", keyChapters: ["2:30", "8:00"] };
  assert.deepEqual(validateVerdict(raw, { chapterStarts: [0, 150] })?.keyStarts, [150]);
  assert.equal("keyStarts" in (validateVerdict(raw) ?? {}), false, "没给章节时不收");
  const broken = validateVerdict({ ...raw, keyChapters: "全部" }, { chapterStarts: [0, 150] });
  assert.equal(broken?.summary, "讲了 A");
  assert.equal(broken && "keyStarts" in broken, false, "一个都没有时不写这个字段");
  assert.equal(validateVerdict({ keyChapters: ["0:00"] }, { chapterStarts: [0] }), null, "重点救不了没有结论的输出");
});

test("交给页面的重点再和当前章节核对：章节换过以后对不上的不标", () => {
  const analysis = { chapters: [{ timestampSeconds: 0 }, { timestampSeconds: 200 }], verdict: { keyStarts: [0, 150] } };
  assert.deepEqual(keyChapterStarts(analysis), [0]);
  assert.deepEqual(keyChapterStarts({ chapters: [{ timestampSeconds: 0 }], verdict: {} }), [], "旧记录没有这个字段");
  assert.deepEqual(keyChapterStarts(null), []);
});

test("读旧结论时把旧档位换算成星，保留理由和存储里的旧值", () => {
  for (const [label, stars] of [
    ["推荐看", 5], ["可以看", 3], ["可跳过", 1],
    ["值得看完整视频", 5], [" 可以跳过 ", 1], ["看概览就够", 2],
  ] as const) {
    const stored = Object.freeze({ summary: "讲了 A", value: "B", verdict: label, reason: "旧理由" });
    assert.equal(verdictLabelOf(label), stars);
    assert.deepEqual(validateVerdict(stored, { stored: true }), { ...stored, verdict: stars });
    assert.deepEqual(validateVerdict(stored), { ...stored, verdict: "", reason: "" });
  }
  for (const stars of VERDICT_STARS) assert.equal(verdictLabelOf(stars), stars);
  for (const odd of ["3", " 3 ", "还行", "", "constructor", "__proto__", null, 0, 6, 3.5]) {
    assert.equal(verdictLabelOf(odd), "", String(odd));
  }
});

test("标题译名：去掉首尾空白；没有、不是字符串、空的、和原标题一样的、超过上限的都当没有", () => {
  const title = "一周计划怎么做";
  assert.equal(translatedTitleOf(" How to Plan a Week \n", title), "How to Plan a Week");
  assert.equal(translatedTitleOf(undefined, title), "");
  assert.equal(translatedTitleOf(42, title), "");
  assert.equal(translatedTitleOf("   ", title), "");
  assert.equal(translatedTitleOf(" 一周计划怎么做 ", title), "", "和原标题一样");
  assert.equal(translatedTitleOf("react  HOOKS guide", "React Hooks Guide"), "", "只差大小写和空白也算一样");
  assert.equal(translatedTitleOf("x".repeat(TRANSLATED_TITLE_MAX), title).length, TRANSLATED_TITLE_MAX);
  assert.equal(translatedTitleOf("x".repeat(TRANSLATED_TITLE_MAX + 1), title), "", "太长的整个丢掉，不截断");
  assert.equal(translatedTitleOf("How to Plan a Week", ""), "", "原标题是空的，译名无从说起");
  assert.equal(translatedTitleOf("How to Plan a Week", "  "), "");
  assert.equal(translatedTitleOf(" How to Plan a Week "), "How to Plan a Week", "读存着的结论时不再和原标题比");
});

test("结论带标题译名：合格的写进 translatedTitle，不合格的只丢译名，结论其余部分照存", () => {
  const raw = { summary: "讲了 A", value: "B", verdict: 3, reason: "C", keyChapters: [] };
  const title = "一周计划怎么做";
  assert.equal(validateVerdict({ ...raw, translatedTitle: "How to Plan a Week" }, { title })?.translatedTitle, "How to Plan a Week");
  for (const bad of [undefined, "", title, "x".repeat(TRANSLATED_TITLE_MAX + 1), ["How"]]) {
    const verdict = validateVerdict({ ...raw, translatedTitle: bad }, { title });
    assert.deepEqual(verdict, { summary: "讲了 A", value: "B", verdict: 3, reason: "C" }, String(bad));
  }
  assert.equal(validateVerdict({ ...raw, translatedTitle: "How to Plan a Week" }, { title: "" })?.translatedTitle, undefined, "没有原标题时不收");
  assert.equal(validateVerdict({ ...raw, translatedTitle: "How to Plan a Week" }, { stored: true })?.translatedTitle, "How to Plan a Week", "存着的照读");
  assert.equal(validateVerdict({ translatedTitle: "How to Plan a Week" }, { title }), null, "译名救不了没有结论的输出");
});
