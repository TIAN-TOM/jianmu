import assert from "node:assert/strict";
import { test } from "node:test";
import { planTranslationBatches } from "../../../../src/core/ai/chunking.ts";
import { alignTranslatedSegments, validateAnalysis } from "../../../../src/core/ai/validate.ts";

test("丢弃超出视频时长的时间戳", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "开场", timestampSeconds: 0 },
        { title: "越界", timestampSeconds: 99999 },
        { title: "结尾", timestampSeconds: 100 },
      ],
      keyQuotes: [
        { quote: "有效", timestampSeconds: 50 },
        { quote: "越界", timestampSeconds: 500 },
      ],
    },
    120,
  );

  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ["开场", "结尾"],
  );
  assert.equal(result.keyQuotes.length, 1);
});

test("显示用时间戳由校验过的秒数反推，不采信模型给的字符串", () => {
  const result = validateAnalysis({ chapters: [{ title: "章", timestampSeconds: 95, timestamp: "9:99" }] }, 600);
  assert.equal(result.chapters[0]?.timestamp, "1:35");
});

test("按时间戳升序排列，不管模型给的顺序", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "第三", timestampSeconds: 300 },
        { title: "第一", timestampSeconds: 10 },
        { title: "第二", timestampSeconds: 100 },
      ],
    },
    600,
  );
  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ["第一", "第二", "第三"],
  );
});

test("缺标题、缺秒数、类型不对的条目一律丢掉", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "", timestampSeconds: 10 },
        { title: "没有秒数" },
        { title: "秒数不是数字", timestampSeconds: "abc" },
        { title: "正常", timestampSeconds: 10 },
      ],
      keyQuotes: [{ quote: 123, timestampSeconds: 10 }],
    },
    600,
  );
  assert.equal(result.chapters.length, 1);
  assert.equal(result.keyQuotes.length, 0);
});

test("字段完全缺失或畸形时返回空结构而不是抛错", () => {
  assert.deepEqual(validateAnalysis(null, 100), {
    chapters: [],
    keyQuotes: [],
  });
  assert.deepEqual(validateAnalysis({ chapters: "不是数组" }, 100).chapters, []);
});

test("超长文本被截断，条目数量有上限", () => {
  const result = validateAnalysis(
    {
      chapters: Array.from({ length: 150 }, (_, i) => ({
        title: "标".repeat(400),
        summary: "摘".repeat(2000),
        timestampSeconds: i,
      })),
    },
    600,
  );
  assert.equal(result.chapters.length, 100);
  assert.equal(result.chapters[0]?.title.length, 300);
  assert.equal(result.chapters[0]?.summary.length, 1500);
});

test("单条就超过字数上限时自己占一批，而不是被丢掉", () => {
  const batches = planTranslationBatches([{ id: "s0", text: "字".repeat(9000) }]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.[0]?.id, "s0");
});

const EN_BATCH = [
  { id: "s1", text: "This is the first complete sentence of the talk." },
  { id: "s2", text: "And here is the second one, which follows it." },
];

test("翻译按 id 对齐，不受返回顺序影响", () => {
  const { translated, rejected } = alignTranslatedSegments(
    {
      segments: [
        { id: "s2", text: "接下来是第二句。" },
        { id: "s1", text: "这是这场演讲的第一句完整的话。" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, {
    s1: "这是这场演讲的第一句完整的话。",
    s2: "接下来是第二句。",
  });
  assert.deepEqual(rejected, []);
});

test("模型把英文原样抄回来时判定为没翻译", () => {
  const { translated, rejected } = alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "This is the first complete sentence of the talk." },
        { id: "s2", text: "接下来是第二句。" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, { s2: "接下来是第二句。" });
  assert.deepEqual(rejected, [{ id: "s1", reason: "NOT_TRANSLATED" }]);
});

test("原文本来就没多少拉丁字母时，不拿「有没有中文」当失败依据", () => {
  // 日文、韩文这类原文译出来可能仍是汉字或假名混排，
  // 用「必须出现中文」去判会误杀。
  const source = [{ id: "s1", text: "これは日本語の字幕です" }];
  const { translated, rejected } = alignTranslatedSegments(
    { segments: [{ id: "s1", text: "これは日本語の字幕です" }] },
    source,
  );

  assert.equal(translated.s1, "これは日本語の字幕です");
  assert.deepEqual(rejected, []);
});

test("中译英：把中文原样抄回来判定为没翻译", () => {
  const source = [
    { id: "s1", text: "这是一段完整的中文字幕内容用来测试" },
    { id: "s2", text: "第二段中文字幕内容也足够长了" },
  ];
  const { translated, rejected } = alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "这是一段完整的中文字幕内容用来测试" },
        { id: "s2", text: "The second Chinese subtitle line is long enough." },
      ],
    },
    source,
    { targetLang: "en" },
  );

  assert.deepEqual(translated, {
    s2: "The second Chinese subtitle line is long enough.",
  });
  assert.deepEqual(rejected, [{ id: "s1", reason: "NOT_TRANSLATED" }]);
});

test("中译英：短句和保留专有名词的译文不被误杀", () => {
  // 「好的」→ "OK" 这类短译文没几个字母，不能拿「必须出现拉丁字母」当依据；
  // 判据是「中文明显变少」——译文里保留个把专有名词的汉字也没关系。
  const source = [
    { id: "s1", text: "好的好的" },
    { id: "s2", text: "我们今天来聊一聊李白的诗歌创作风格" },
  ];
  const { translated, rejected } = alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "OK" },
        { id: "s2", text: "Today we talk about 李白's poetry style." },
      ],
    },
    source,
    { targetLang: "en" },
  );

  assert.equal(translated.s1, "OK");
  assert.equal(translated.s2, "Today we talk about 李白's poetry style.");
  assert.deepEqual(rejected, []);
});

test("翻译同样拒绝漏条、编造 id 和空文本", () => {
  const { translated, rejected } = alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "   " },
        { id: "s9", text: "凭空多出来的一条" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, {});
  assert.deepEqual(rejected.map((item) => item.reason).sort(), ["EMPTY_TEXT", "MISSING", "UNKNOWN_ID"]);
});

test("翻译拒绝重复的 id，只采用第一条", () => {
  const { translated, rejected } = alignTranslatedSegments(
    {
      segments: [
        { id: "s1", text: "这是这场演讲的第一句。" },
        { id: "s1", text: "重复的一条。" },
        { id: "s2", text: "这是紧跟着的第二句。" },
      ],
    },
    EN_BATCH,
  );

  assert.deepEqual(translated, { s1: "这是这场演讲的第一句。", s2: "这是紧跟着的第二句。" });
  assert.deepEqual(rejected, [{ id: "s1", reason: "DUPLICATE_ID" }]);
});

test("翻译返回结构完全畸形时，整批退回原文而不是抛错", () => {
  assert.deepEqual(alignTranslatedSegments(null, EN_BATCH).translated, {});
  assert.deepEqual(alignTranslatedSegments({ segments: "不是数组" }, EN_BATCH).translated, {});
  assert.equal(alignTranslatedSegments(null, EN_BATCH).rejected.length, 2);
});
