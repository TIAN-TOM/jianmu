import assert from "node:assert/strict";
import { test } from "node:test";
import { planTranslationBatches } from "../../../../src/core/ai/chunking.ts";
import { alignTranslatedSegments, looksLikeTranslation, validateAnalysis } from "../../../../src/core/ai/validate.ts";

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

test("正好等于视频时长的时间戳保留，超出才丢", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "末尾", timestampSeconds: 120 },
        { title: "越界", timestampSeconds: 121 },
      ],
      keyQuotes: [
        { quote: "末尾", timestampSeconds: 120 },
        { quote: "越界", timestampSeconds: 120.5 },
      ],
    },
    120,
  );
  assert.deepEqual(result.chapters.map((c) => c.title), ["末尾"]);
  assert.deepEqual(result.keyQuotes.map((q) => q.quote), ["末尾"]);
});

test("时长不是正数时不按时长裁剪，时长为 1 秒时照常裁", () => {
  const late = { chapters: [{ title: "很晚", timestampSeconds: 5000 }] };
  for (const max of [0, -5, Number.NaN, undefined, "未知"]) {
    assert.deepEqual(validateAnalysis(late, max).chapters.map((c) => c.title), ["很晚"], String(max));
  }
  const short = {
    chapters: [
      { title: "第一秒", timestampSeconds: 1 },
      { title: "第二秒", timestampSeconds: 2 },
    ],
  };
  assert.deepEqual(validateAnalysis(short, 1).chapters.map((c) => c.title), ["第一秒"]);
});

test("分块的起点之前的条目丢掉，正好在起点上的保留", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "上一块的", timestampSeconds: 0 },
        { title: "起点", timestampSeconds: 1 },
      ],
      keyQuotes: [
        { quote: "上一块的", timestampSeconds: 0.5 },
        { quote: "起点", timestampSeconds: 1 },
      ],
    },
    600,
    1,
  );
  assert.deepEqual(result.chapters.map((c) => c.title), ["起点"]);
  assert.deepEqual(result.keyQuotes.map((q) => q.quote), ["起点"]);
});

test("秒数带小数时向下取整，显示用时间戳跟着取整后的秒数", () => {
  const result = validateAnalysis(
    {
      chapters: [{ title: "章", timestampSeconds: 95.9 }],
      keyQuotes: [{ quote: "句", timestampSeconds: 59.99 }],
    },
    600,
  );
  assert.deepEqual(
    [result.chapters[0]?.timestampSeconds, result.chapters[0]?.timestamp],
    [95, "1:35"],
  );
  assert.deepEqual(
    [result.keyQuotes[0]?.timestampSeconds, result.keyQuotes[0]?.timestamp],
    [59, "0:59"],
  );
});

test("标题、摘要和金句去掉首尾空白，只剩空白的条目丢掉", () => {
  const result = validateAnalysis(
    {
      chapters: [
        { title: "  开场  ", summary: "  讲了背景  ", timestampSeconds: 0 },
        { title: "   ", summary: "有摘要没标题", timestampSeconds: 10 },
      ],
      keyQuotes: [
        { quote: "  一句金句  ", timestampSeconds: 5 },
        { quote: " \n ", timestampSeconds: 6 },
      ],
    },
    600,
  );
  assert.deepEqual(
    result.chapters.map((c) => [c.title, c.summary]),
    [["开场", "讲了背景"]],
  );
  assert.deepEqual(result.keyQuotes.map((q) => q.quote), ["一句金句"]);
});

test("金句超过 3000 字截断，条数最多 50 条", () => {
  const result = validateAnalysis(
    {
      keyQuotes: Array.from({ length: 60 }, (_, i) => ({ quote: "句".repeat(3001), timestampSeconds: i })),
    },
    600,
  );
  assert.equal(result.keyQuotes.length, 50);
  assert.equal(result.keyQuotes[0]?.quote.length, 3000);
});

test("中译英：原文 10 个汉字起才检查，译文汉字少于原文一半才算翻译了", () => {
  const nine = "一二三四五六七八九";
  const ten = "一二三四五六七八九十";
  assert.equal(looksLikeTranslation(nine, nine, "en"), true, "不到 10 个汉字不检查");
  assert.equal(looksLikeTranslation(ten, ten, "en"), false, "10 个汉字原样抄回来算没翻译");
  assert.equal(looksLikeTranslation("Name: 一二三四", ten, "en"), true, "留 4 个汉字，少于一半");
  assert.equal(looksLikeTranslation("Name: 一二三四五", ten, "en"), false, "留 5 个汉字，正好一半");
});

test("译成中文：原文 20 个拉丁字母起才检查，译文出现一个汉字就算翻译了", () => {
  const nineteen = "word ".repeat(4) + "abc";
  const twenty = "word ".repeat(5);
  assert.equal(looksLikeTranslation(nineteen, nineteen), true, "不到 20 个字母不检查");
  assert.equal(looksLikeTranslation(twenty, twenty), false, "20 个字母原样抄回来算没翻译");
  assert.equal(looksLikeTranslation(`${twenty}好`, twenty), true, "出现一个汉字就算");
});
