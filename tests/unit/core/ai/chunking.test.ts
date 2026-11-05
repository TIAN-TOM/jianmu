import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisTimingVariables,
  chunkFailureRanges,
  chunksForFailureRanges,
  estimateOutputTokens,
  groupQuotesIntoChapters,
  mergeAnalyses,
  mergeRetryIntoAnalysis,
  planAnalysisChunks,
  planTranslationBatches,
  truncatedChunkRanges,
  withTruncatedRanges,
} from "../../../../src/core/ai/chunking.ts";
import { validateAnalysis } from "../../../../src/core/ai/validate.ts";
import { formatTimestamp } from "../../../../src/core/transcript/segment.ts";

test("时长取元数据与字幕末尾时间戳里的较大值", () => {
  const transcript = "[0:00] 开头\n[5:00] 中间\n[9:30] 结尾";

  // 元数据时长偏小（B 站偶尔如此），以字幕为准
  const fromTranscript = analysisTimingVariables(transcript, 100);
  assert.equal(fromTranscript.maxTimestampSeconds, 570);
  assert.equal(fromTranscript.durationFormatted, "9:30");

  // 元数据更大时以元数据为准
  const fromMetadata = analysisTimingVariables(transcript, 1200);
  assert.equal(fromMetadata.maxTimestampSeconds, 1200);
});

test("lateThreshold 落在 75% 处，用来逼模型覆盖后半段", () => {
  const timing = analysisTimingVariables("[0:00] 开头", 400);
  assert.equal(timing.lateThreshold, "5:00");
});

test("没有字幕也没有时长时不会崩", () => {
  const timing = analysisTimingVariables("", 0);
  assert.equal(timing.maxTimestampSeconds, 0);
  assert.equal(timing.durationFormatted, "0:00");
});

const makeAnalysisSegments = (count: number, length: number): { id: string; start: number; text: string }[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    start: i * 30,
    text: "字".repeat(length),
  }));

test("短字幕不分块，避免多余的往返", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(10, 100));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.index, 0);
  assert.equal(chunks[0]?.startSeconds, 0);
});

test("较短模式可以降低不分块阈值", () => {
  const segments = makeAnalysisSegments(20, 250);
  assert.equal(planAnalysisChunks(segments).length, 1);
  assert.ok(planAnalysisChunks(segments, { maxChars: 3500, singleChars: 3500 }).length > 1);
});

test("长字幕按分段边界切块，每块不超过上限", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
  });
  assert.ok(chunks.length > 1, "三万字应当被切开");
  for (const chunk of chunks) {
    const chars = chunk.segments.reduce((sum, s) => sum + s.text.length, 0);
    assert.ok(chars <= 6300, `某块字数 ${chars} 明显超出上限`);
  }
});

test("分块覆盖全部分段，既不丢也不重", () => {
  const segments = makeAnalysisSegments(100, 300);
  const chunks = planAnalysisChunks(segments, { maxChars: 6000 });
  const ids = chunks.flatMap((chunk) => chunk.segments.map((s) => s.id));
  assert.deepEqual(
    ids,
    segments.map((s) => s.id),
  );
});

test("每块带上自己的时间区间与带时间戳的文本", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
  });
  const second = chunks[1]!;
  assert.ok(second.startSeconds > 0, "第二块不该从 0 秒开始");
  assert.ok(second.endSeconds >= second.startSeconds);
  assert.match(second.text, /^\[\d+:\d{2}\] /);
});

test("没有分段时返回空数组", () => {
  assert.deepEqual(planAnalysisChunks([]), []);
  assert.deepEqual(planAnalysisChunks(null), []);
  assert.deepEqual(planAnalysisChunks([{ id: "a", start: 0, text: "" }]), []);
});

test("除第一块外，每块带上一块结尾作为前情", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
    overlapChars: 400,
  });
  assert.equal(chunks[0]?.contextText, "", "第一块前面没有内容可回顾");
  for (const chunk of chunks.slice(1)) {
    assert.match(chunk.contextText, /^\[\d+:\d{2}\] /);
    // 够用就停：只多喂一点上下文，不是把上一块整个再发一遍。
    assert.ok(
      chunk.contextText.length >= 400 && chunk.contextText.length < 1200,
      `前情长度 ${chunk.contextText.length} 不在预期区间`,
    );
  }
});

test("前情取自上一块的末尾，而不是本块自己的开头", () => {
  const segments = makeAnalysisSegments(100, 300);
  const chunks = planAnalysisChunks(segments, { maxChars: 6000 });
  const first = chunks[0]!;
  const previous = first.segments[first.segments.length - 1]!;
  assert.ok(
    chunks[1]?.contextText.includes(`[${formatTimestamp(previous.start)}]`),
    "前情应当以上一块的最后一段收尾",
  );
});

test("关掉重叠就没有前情", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(100, 300), {
    maxChars: 6000,
    overlapChars: 0,
  });
  assert.ok(chunks.every((chunk) => chunk.contextText === ""));
});

test("分块时丢弃早于本块起点的时间戳，前情不归本块认领", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "前情里的一章", timestampSeconds: 100 },
        { title: "本块的一章", timestampSeconds: 400 },
      ],
      keyQuotes: [
        { quote: "前情里的金句", timestampSeconds: 120 },
        { quote: "本块的金句", timestampSeconds: 500 },
      ],
    },
    900,
    300,
  );
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.title),
    ["本块的一章"],
  );
  assert.deepEqual(
    result.keyQuotes.map((quote) => quote.quote),
    ["本块的金句"],
  );
});

test("合并多块结果并按时间排序", () => {
  const merged = mergeAnalyses(
    [
      {
        chapters: [{ title: "第二块的章", timestampSeconds: 300, timestamp: "5:00" }],
        keyQuotes: [{ quote: "后面的金句", timestampSeconds: 320, timestamp: "5:20" }],
      },
      {
        chapters: [{ title: "第一块的章", timestampSeconds: 10, timestamp: "0:10" }],
        keyQuotes: [{ quote: "前面的金句", timestampSeconds: 20, timestamp: "0:20" }],
      },
    ],
    600,
  );

  assert.deepEqual(
    merged.chapters.map((c) => c.title),
    ["第一块的章", "第二块的章"],
  );
  assert.deepEqual(
    merged.keyQuotes.map((q) => q.quote),
    ["前面的金句", "后面的金句"],
  );
});

test("块边界产生的重复章节与重复金句被去掉", () => {
  const merged = mergeAnalyses(
    [
      {
        chapters: [{ title: "边界章节", timestampSeconds: 100, timestamp: "1:40" }],
        keyQuotes: [{ quote: "同一句话", timestampSeconds: 100, timestamp: "1:40" }],
      },
      {
        chapters: [{ title: "边界章节（重复）", timestampSeconds: 100, timestamp: "1:40" }],
        keyQuotes: [{ quote: "同一句话", timestampSeconds: 105, timestamp: "1:45" }],
      },
    ],
    600,
  );
  assert.equal(merged.chapters.length, 1);
  assert.equal(merged.keyQuotes.length, 1);
});

test("合并时仍然剔除超出视频时长的条目", () => {
  const merged = mergeAnalyses([{ chapters: [{ title: "越界", timestampSeconds: 9999, timestamp: "166:39" }] }], 600);
  assert.equal(merged.chapters.length, 0);
});

test("部分块为空或畸形时，合并仍然产出其余块的结果", () => {
  const merged = mergeAnalyses(
    [null, {}, { chapters: [{ title: "唯一有效的章", timestampSeconds: 10, timestamp: "0:10" }] }],
    600,
  );
  assert.equal(merged.chapters.length, 1);
  assert.deepEqual(mergeAnalyses([], 600).chapters, []);
  assert.deepEqual(mergeAnalyses(null, 600).chapters, []);
});

test("失败区间记下给人看的原因，翻译不出时退回原始报错", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(40, 300), { maxChars: 6000 });
  const results = [
    { status: "rejected", reason: Object.assign(new Error("raw 429"), { status: 429 }) },
    { status: "rejected", reason: new Error("JSON 解析失败") },
  ];
  const described = chunkFailureRanges(chunks, results, (error) =>
    (error as { status?: number }).status === 429 ? "服务商限流了，请稍后重试。" : "",
  );
  assert.equal(described[0]?.reason, "服务商限流了，请稍后重试。");
  assert.equal(described[1]?.reason, "JSON 解析失败");
  assert.equal("reason" in chunkFailureRanges(chunks, results)[0]!, false, "不传 describe 时不带 reason");
});

test("失败区间能对回当前分块，补进去时覆盖该时段旧条目", () => {
  const chunks = planAnalysisChunks(makeAnalysisSegments(40, 300), { maxChars: 6000 });
  assert.ok(chunks.length >= 2);
  const failed = chunkFailureRanges(chunks, [
    { status: "fulfilled", value: {} },
    { status: "rejected", reason: new Error("限流") },
  ]);
  assert.equal(failed.length, 1);
  const first = failed[0]!;
  assert.equal(first.index, 1);
  assert.deepEqual(
    chunksForFailureRanges(chunks, failed).map((chunk) => chunk.index),
    [1],
  );

  const merged = mergeRetryIntoAnalysis(
    {
      chapters: [
        { title: "保留", timestampSeconds: 10, timestamp: "0:10" },
        { title: "旧的后半", timestampSeconds: first.startSeconds, timestamp: "x" },
      ],
      keyQuotes: [],
    },
    [
      {
        chapters: [{ title: "新的后半", timestampSeconds: first.startSeconds + 5, timestamp: "y" }],
      },
    ],
    failed,
    2000,
  );
  assert.deepEqual(
    merged.chapters.map((chapter) => chapter.title),
    ["保留", "新的后半"],
  );
});

const CHAPTERS = [
  { title: "开场", timestampSeconds: 0 },
  { title: "训练目标", timestampSeconds: 112 },
  { title: "泛化实验", timestampSeconds: 276 },
];

test("金句按时间戳归入所属章节，边界归前一章", () => {
  const { grouped, orphans } = groupQuotesIntoChapters(CHAPTERS, [
    { quote: "开场白", timestampSeconds: 30 },
    { quote: "正好压在边界", timestampSeconds: 112 },
    { quote: "泛化的金句", timestampSeconds: 300 },
  ]);

  assert.deepEqual(
    grouped.map((group) => group.quotes.map((quote) => quote.quote)),
    [["开场白"], ["正好压在边界"], ["泛化的金句"]],
  );
  assert.deepEqual(orphans, []);
});

test("章节空档里的金句归入前一个章节", () => {
  const { grouped } = groupQuotesIntoChapters(CHAPTERS, [{ quote: "落在空档", timestampSeconds: 200 }]);
  assert.deepEqual(
    grouped[1]?.quotes.map((quote) => quote.quote),
    ["落在空档"],
  );
});

test("第一章之前的金句归为 orphan，而不是塞进第一章", () => {
  const lateChapters = CHAPTERS.filter((chapter) => chapter.timestampSeconds > 0);
  const { grouped, orphans } = groupQuotesIntoChapters(lateChapters, [
    { quote: "片头语", timestampSeconds: 5 },
    { quote: "正文金句", timestampSeconds: 300 },
  ]);

  assert.deepEqual(
    grouped.map((group) => group.quotes.length),
    [0, 1],
  );
  assert.deepEqual(
    orphans.map((quote) => quote.quote),
    ["片头语"],
  );
});

test("没有章节时金句全部归为 orphan", () => {
  const { grouped, orphans } = groupQuotesIntoChapters([], [{ quote: "唯一金句", timestampSeconds: 42 }]);
  assert.deepEqual(grouped, []);
  assert.equal(orphans.length, 1);
});

test("畸形输入不抛错：非数组或时间戳缺失的条目被忽略", () => {
  const { grouped, orphans } = groupQuotesIntoChapters(null, [
    { quote: "没有时间戳" },
    { quote: "有效金句", timestampSeconds: 10 },
  ]);
  assert.deepEqual(grouped, []);
  assert.deepEqual(
    orphans.map((quote) => quote.quote),
    ["有效金句"],
  );
});

const makeSegments = (count: number, length = 10): { id: string; text: string }[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    text: "字".repeat(length),
  }));

test("翻译批次每批最多 4 条：翻译要重组整句，批次大了容易漏条或越译越简", () => {
  const batches = planTranslationBatches(makeSegments(10));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [4, 4, 2],
  );
});

test("翻译批次按字数上限分批，避免某几批过长", () => {
  const batches = planTranslationBatches(makeSegments(6, 500));
  for (const batch of batches) {
    const chars = batch.reduce((sum, segment) => sum + segment.text.length, 0);
    assert.ok(chars <= 1200, `批次字数 ${chars} 超出预期`);
  }
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [2, 2, 2],
  );
});

test("空分段被跳过，空输入返回空数组", () => {
  const batches = planTranslationBatches([
    { id: "s0", text: "" },
    { id: "s1", text: "有内容" },
  ]);
  assert.deepEqual(batches, [[{ id: "s1", text: "有内容" }]]);
  assert.deepEqual(planTranslationBatches([]), []);
  assert.deepEqual(planTranslationBatches(null), []);
});

test("预算随输入量增长，而不是写死一个常量", () => {
  const small = estimateOutputTokens(500, { ratio: 1.5, floor: 100 });
  const large = estimateOutputTokens(3000, { ratio: 1.5, floor: 100 });
  assert.ok(large > small, "批次变大时预算必须跟着变大，否则大批次会被截断");
});

test("预算带固定余量，短输入也不会小到放不下 JSON 结构", () => {
  assert.ok(estimateOutputTokens(10, { ratio: 1, floor: 0 }) >= 512);
});

test("预算被夹在上下界之间", () => {
  assert.equal(estimateOutputTokens(1, { floor: 2048 }), 2048);
  assert.equal(
    estimateOutputTokens(1_000_000, { ratio: 1, ceiling: 8192 }),
    8192,
    "超过模型自身输出上限的值会被服务直接拒掉",
  );
});

test("预算对畸形输入回落到下界", () => {
  for (const bad of [null, undefined, NaN, -100, "字符串"]) {
    assert.equal(estimateOutputTokens(bad as number, { floor: 1024 }), 1024, `输入 ${String(bad)} 时应回落到下界`);
  }
});

test("摘要类任务的预算小于等量输入的改写类任务", () => {
  const rewrite = estimateOutputTokens(6000, { ratio: 1.5, ceiling: 99999 });
  const summarize = estimateOutputTokens(6000, { ratio: 0.5, ceiling: 99999 });
  assert.ok(summarize < rewrite);
});

test("截断区间只记成功且被截断的分块，没有截断时不留字段", () => {
  const chunks = [
    { index: 0, startSeconds: 0, endSeconds: 100 },
    { index: 1, startSeconds: 100, endSeconds: 200 },
    { index: 2, startSeconds: 200, endSeconds: 300 },
  ];
  const results = [
    { status: "fulfilled", value: { chapters: [], truncated: true } },
    { status: "rejected", reason: Object.assign(new Error("空"), { truncated: true }) },
    { status: "fulfilled", value: { chapters: [] } },
  ];
  assert.deepEqual(truncatedChunkRanges(chunks, results), [{ startSeconds: 0, endSeconds: 100 }]);

  const analysis = { chapters: [{ title: "章" }], keyQuotes: [], verdict: { summary: "v" } };
  assert.deepEqual(withTruncatedRanges(analysis, []), analysis, "没截断就不加字段");
  assert.deepEqual(withTruncatedRanges(analysis, [{ startSeconds: 0, endSeconds: 100 }]).truncatedRanges, [
    { startSeconds: 0, endSeconds: 100 },
  ]);
});

test("补失败块时截断区间：被重试的区间换成这次的结果，别处的旧记录留着", () => {
  const existing = {
    chapters: [],
    keyQuotes: [],
    truncatedRanges: [
      { startSeconds: 0, endSeconds: 100 },
      { startSeconds: 100, endSeconds: 200 },
    ],
  };
  const merged = withTruncatedRanges(existing, [{ startSeconds: 200, endSeconds: 300 }], {
    replacing: [{ startSeconds: 100, endSeconds: 200 }],
  });
  assert.deepEqual(merged.truncatedRanges, [
    { startSeconds: 0, endSeconds: 100 },
    { startSeconds: 200, endSeconds: 300 },
  ]);
  const cleared = withTruncatedRanges(
    { chapters: [], truncatedRanges: [{ startSeconds: 0, endSeconds: 100 }] },
    [],
    { replacing: [{ startSeconds: 0, endSeconds: 100 }] },
  );
  assert.equal("truncatedRanges" in cleared, false);
});
