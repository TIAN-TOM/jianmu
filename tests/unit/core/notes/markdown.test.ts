import assert from "node:assert/strict";
import { test } from "node:test";
import { learningAsMarkdown, notesAsMarkdown, type LearningInput } from "../../../../src/core/notes/markdown.ts";
import type { NoteFields, NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";
const ID_A = "BV1Sample000";
const ID_B = "BV1Sample001";
const KEY_A = videoKey({ platform: "bilibili", videoId: ID_A });
const KEY_B = videoKey({ platform: "bilibili", videoId: ID_B, segment: 2 });
const KEY_YOUTUBE = videoKey({ platform: "youtube", videoId: "sample_id" });

const learning = (input?: LearningInput): string => learningAsMarkdown(input, VIDEO_BASE);

const note = (extra: Partial<NoteRecord>): NoteRecord => ({
  id: "note_x",
  kind: "note",
  origin: "user",
  video: KEY_A,
  snapshot: { title: "", author: "" },
  atSec: 0,
  text: "",
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

// 草稿字段不属于记录，留着是为了验证它进不了导出。
const NOTE_A = {
  ...note({
    id: "note_a",
    snapshot: { title: "第一个视频", author: "UP 甲" },
    atSec: 65,
    text: "较早的一条",
    createdAt: 1000,
  }),
  aiDraft: { text: "未确认的草稿" },
};

const NOTE_B = note({
  id: "note_b",
  snapshot: { title: "第一个视频", author: "UP 甲" },
  atSec: 12,
  text: "第一行\n第二行",
  createdAt: 1500,
});

const NOTE_C = note({
  id: "note_c",
  video: KEY_B,
  snapshot: { title: "第二个视频", author: "UP 乙" },
  atSec: 120,
  text: "另一部的笔记",
  createdAt: 3000,
});

test("空笔记列表导出为空字符串", () => {
  assert.equal(notesAsMarkdown([], VIDEO_BASE), "");
  assert.equal(notesAsMarkdown(null, VIDEO_BASE, { grouped: true }), "");
});

test("单视频导出按时间戳升序，且不含 AI 草稿", () => {
  const markdown = notesAsMarkdown([NOTE_A, NOTE_B], VIDEO_BASE);
  assert.equal(
    markdown,
    [
      "# 第一个视频",
      "",
      "UP 甲",
      `${VIDEO_BASE}${ID_A}`,
      "",
      `- [0:12](${VIDEO_BASE}${ID_A}?t=12) 第一行`,
      "  第二行",
      `- [1:05](${VIDEO_BASE}${ID_A}?t=65) 较早的一条`,
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(markdown, /未确认的草稿/);
});

test("全部分组时组内升序、组之间按最新笔记倒序", () => {
  const markdown = notesAsMarkdown([NOTE_A, NOTE_B, NOTE_C], VIDEO_BASE, { grouped: true });
  assert.equal(
    markdown,
    [
      "# 第二个视频",
      "",
      "UP 乙 · P2",
      `${VIDEO_BASE}${ID_B}?p=2`,
      "",
      `- [2:00](${VIDEO_BASE}${ID_B}?p=2&t=120) 另一部的笔记`,
      "",
      "# 第一个视频",
      "",
      "UP 甲",
      `${VIDEO_BASE}${ID_A}`,
      "",
      `- [0:12](${VIDEO_BASE}${ID_A}?t=12) 第一行`,
      "  第二行",
      `- [1:05](${VIDEO_BASE}${ID_A}?t=65) 较早的一条`,
      "",
    ].join("\n"),
  );
});

test("学习稿没有章节、笔记和字幕时导出为空", () => {
  assert.equal(learning({}), "");
  assert.equal(learning({ notes: [], analysis: { chapters: [] } }), "");
});

test("学习稿把一句话结论放在最前面", () => {
  const markdown = learning({
    title: "标题",
    videoKey: KEY_A,
    analysis: {
      chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "章", summary: "摘" }],
      keyQuotes: [],
      verdict: { summary: "讲了 A", value: "得到 B", verdict: "看概览就够", reason: "要点都在章节里" },
    },
    notes: [],
  });
  const verdictAt = markdown.indexOf("## 一句话结论");
  assert.ok(verdictAt > 0);
  assert.ok(verdictAt < markdown.indexOf("## 视频概览"), "结论在章节之前");
  assert.match(markdown, /\*\*看概览就够\*\*\n\n讲了 A\n\n- 核心价值：得到 B\n- 判断理由：要点都在章节里/);
});

test("没有结论的旧概览，学习稿不出现结论小节", () => {
  const markdown = learning({
    videoKey: KEY_A,
    analysis: { chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "章" }], keyQuotes: [] },
    notes: [],
  });
  assert.doesNotMatch(markdown, /一句话结论/);
});

test("多行文本嵌进行内结构时，续行必须留在原结构里", () => {
  const markdown = learning({
    title: "第一行\n第二行",
    videoKey: KEY_A,
    analysis: {
      chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "章", summary: "摘" }],
      keyQuotes: [
        { timestamp: "0:20", timestampSeconds: 20, quote: "第一句\n第二句" },
        // 时间戳落在第一章之前的金句归为 orphan，走散列表的「- 」渲染
        { timestamp: "0:05", timestampSeconds: 5, quote: "孤儿一句\n孤儿二句" },
      ],
    },
    notes: [],
  });
  const lines = markdown.split("\n");
  const titleLine = lines.find((line) => line.startsWith("title:"));
  assert.match(titleLine ?? "", /\\n/, "YAML 双引号标量里的换行必须转义，否则重解析折叠成空格");

  const chapterQuote = lines.findIndex((line) => line.startsWith("> ") && line.includes("第一句"));
  assert.ok(chapterQuote >= 0);
  assert.match(lines[chapterQuote + 1] ?? "", /^> /, "引用块的续行要带 > 前缀");

  const looseQuote = lines.findIndex((line) => line.startsWith("- ") && line.includes("孤儿一句"));
  assert.ok(looseQuote >= 0);
  assert.match(lines[looseQuote + 1] ?? "", /^ {2}/, "列表项的续行要缩进两个空格");
});

test("学习稿带 YAML、章节内金句、笔记，不含 AI 草稿", () => {
  const withDraft = { ...NOTE_A, aiDraft: { text: "不该出现" } };
  const markdown = learning({
    title: "如何听懂",
    author: "实验室",
    videoKey: KEY_A,
    exportedAt: "2026-08-19T12:00:00.000Z",
    analysis: {
      chapters: [{ timestamp: "0:08", timestampSeconds: 8, title: "拆成三步", summary: "先结构后概念。" }],
      keyQuotes: [{ timestamp: "0:32", timestampSeconds: 32, quote: "心里要有一张地图。" }],
    },
    notes: [withDraft],
  });

  assert.equal(
    markdown,
    [
      "---",
      "title: 如何听懂",
      `videoKey: ${KEY_A}`,
      "author: 实验室",
      `url: "${VIDEO_BASE}${ID_A}"`,
      "created_at: 2026-08-19",
      "tags:",
      "  - 简幕",
      "---",
      "",
      "## 视频概览",
      "",
      `- [0:08](${VIDEO_BASE}${ID_A}?t=8) 拆成三步`,
      "",
      "## 章节",
      "",
      `### [0:08](${VIDEO_BASE}${ID_A}?t=8) 拆成三步`,
      "",
      "先结构后概念。",
      "",
      `> [0:32](${VIDEO_BASE}${ID_A}?t=32) 心里要有一张地图。`,
      "",
      "## 我的时间戳笔记",
      "",
      `- [1:05](${VIDEO_BASE}${ID_A}?t=65) 较早的一条`,
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(markdown, /不该出现/);
});

test("章前金句单独成节；学习稿不再附带字幕，传了字幕也不写进去", () => {
  const input = {
    title: "课: 开场",
    videoKey: KEY_B,
    exportedAt: "2026-08-19T12:00:00.000Z",
    analysis: {
      chapters: [{ timestamp: "1:00", timestampSeconds: 60, title: "正题", summary: "进入正题。" }],
      keyQuotes: [{ timestamp: "0:10", timestampSeconds: 10, quote: "片头语" }],
    },
    transcript: {
      mode: "bilingual",
      segments: [{ start: 8, source: "先抓住结构。", translation: "Start with structure." }],
    },
  };
  const markdown = learning(input);

  assert.match(markdown, /^title: "课: 开场"$/m);
  assert.ok(markdown.includes(`url: "${VIDEO_BASE}${ID_B}?p=2"`), markdown);
  assert.match(markdown, /## 金句/);
  assert.ok(markdown.includes(`- [0:10](${VIDEO_BASE}${ID_B}?p=2&t=10) 片头语`), markdown);
  assert.doesNotMatch(markdown, /## 我的时间戳笔记/);
  assert.doesNotMatch(markdown, /完整字幕|先抓住结构|Start with structure/);
});

test("概览缺块时学习稿注明内容不完整，列出缺失时段和原因", () => {
  const markdown = learning({
    title: "标题",
    videoKey: KEY_A,
    analysis: {
      chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "章" }],
      keyQuotes: [],
      verdict: { summary: "讲了前半", verdict: "信息不足", reason: "后半缺失", incomplete: true },
    },
    analysisFailures: [{ index: 1, startSeconds: 600, endSeconds: 1170, reason: "服务限流了" }],
    notes: [],
  });
  const noticeAt = markdown.indexOf("概览内容不完整");
  assert.ok(noticeAt > 0, markdown);
  assert.ok(noticeAt < markdown.indexOf("## 一句话结论"), "不完整的提示放在最前面");
  assert.match(markdown, /> - 10:00–19:30：服务限流了/);
  assert.match(markdown, /\*\*信息不足\*\*\n\n\*这条结论只基于概览里已有的部分/);

  const complete = learning({
    videoKey: KEY_A,
    analysis: { chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "章" }], keyQuotes: [] },
    analysisFailures: [],
  });
  assert.doesNotMatch(complete, /不完整/);
});

const OFFICIAL = {
  status: "ok",
  summary: "官方总摘要。",
  outline: [
    {
      title: "第一段",
      timestamp: 1,
      points: [
        { timestamp: 39, content: "要点一" },
        { timestamp: null, content: "没有时间的要点" },
      ],
    },
    { title: "", timestamp: null, points: [] },
  ],
};

test("只有官方总结也能导出学习稿，放在最前面并注明来源", () => {
  const markdown = learning({
    title: "标题",
    videoKey: KEY_A,
    exportedAt: "2026-11-01T00:00:00.000Z",
    officialSummary: OFFICIAL,
    notes: [],
  });
  assert.ok(markdown, "官方总结本身就是可导出的内容");
  const body = markdown.split("---\n").pop() ?? "";
  assert.ok(body.startsWith("\n## B站官方总结\n"), "紧跟在 YAML 后面");
  assert.match(markdown, /> 来源：B站官方 AI 总结，由 B站生成，不是你配置的模型。/);
  assert.match(markdown, /\n官方总摘要。\n/);
  assert.ok(markdown.includes(`### [0:01](${VIDEO_BASE}${ID_A}?t=1) 第一段`), markdown);
  assert.ok(markdown.includes(`- [0:39](${VIDEO_BASE}${ID_A}?t=39) 要点一`), markdown);
  assert.match(markdown, /\n- 没有时间的要点\n/, "没有时间戳的要点不编一个 0:00");
  assert.match(markdown, /### （这一段没有标题）/);
  assert.doesNotMatch(markdown, /由你配置的 AI 模型/, "没有用户模型的内容时不写那条说明");
});

test("官方总结和用户模型的概览同时导出时，两边都标明来源", () => {
  const markdown = learning({
    videoKey: KEY_A,
    officialSummary: OFFICIAL,
    analysis: {
      chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "模型章节" }],
      keyQuotes: [],
      verdict: { summary: "模型结论", verdict: "值得看" },
    },
    notes: [],
  });
  const officialAt = markdown.indexOf("## B站官方总结");
  const noteAt = markdown.indexOf("> 以下结论、章节和金句由你配置的 AI 模型根据字幕生成。");
  assert.ok(officialAt > 0 && noteAt > officialAt);
  assert.ok(noteAt < markdown.indexOf("## 一句话结论"));
  assert.ok(markdown.indexOf("## 一句话结论") < markdown.indexOf("## 视频概览"));
});

test("用官方总结写的结论导出时注明来源，不说成根据字幕生成", () => {
  const verdict = { summary: "官方说讲了 A", verdict: "看概览就够", source: "official" };
  const only = learning({
    videoKey: KEY_A,
    officialSummary: OFFICIAL,
    analysis: { chapters: [], keyQuotes: [], verdict },
    notes: [],
  });
  assert.match(
    only,
    /## 一句话结论\n\n\*\*看概览就够\*\*\n\n\*这条结论由你配置的 AI 模型根据 B站官方总结写成，不是根据字幕。\*\n\n官方说讲了 A/,
  );
  assert.doesNotMatch(only, /根据字幕生成/);

  const withChapters = learning({
    videoKey: KEY_A,
    officialSummary: OFFICIAL,
    analysis: {
      chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "模型章节" }],
      keyQuotes: [],
      verdict,
    },
    notes: [],
  });
  assert.match(withChapters, /> 以下章节和金句由你配置的 AI 模型根据字幕生成。/);
  assert.doesNotMatch(withChapters, /以下结论、章节和金句/);
  assert.match(withChapters, /根据 B站官方总结写成/);
});

test("官方总结没有内容时学习稿里不出现这一节", () => {
  const markdown = learning({
    videoKey: KEY_A,
    officialSummary: { status: "none", summary: "", outline: [] },
    analysis: { chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "章" }], keyQuotes: [] },
  });
  assert.doesNotMatch(markdown, /B站官方总结|由你配置的 AI 模型/);
  assert.equal(learning({ officialSummary: { status: "none" } }), "");
});

test("只有字幕、没有导读、概览和笔记时，学习稿是空的", () => {
  const input = {
    videoKey: KEY_A,
    transcript: {
      mode: "original",
      sourceLabel: "B站官方总结里的 AI 字幕",
      segments: [{ start: 0, display: "第一句", source: "第一句" }],
    },
  };
  assert.equal(learning(input), "");
});

test("UP 主分段写进学习稿：跟在官方总结后面，带跳转链接并注明来源", () => {
  const creatorChapters = [
    { title: "开场", start: 0, end: 60 },
    { title: "", start: 95.5, end: null },
    { title: "坏数据", start: null },
  ];
  const markdown = learning({
    videoKey: KEY_A,
    officialSummary: OFFICIAL,
    creatorChapters,
    analysis: { chapters: [{ timestamp: "0:10", timestampSeconds: 10, title: "模型章节" }], keyQuotes: [] },
  });
  const officialAt = markdown.indexOf("## B站官方总结");
  const upAt = markdown.indexOf("## UP 主分段");
  assert.ok(officialAt > 0 && upAt > officialAt);
  assert.ok(upAt < markdown.indexOf("> 以下结论、章节和金句由你配置的 AI 模型根据字幕生成。"));
  assert.ok(
    markdown.includes(
      [
        "## UP 主分段",
        "",
        "> 来源：UP 主在 B站为视频划分的章节。",
        "",
        `- [0:00](${VIDEO_BASE}${ID_A}) 开场`,
        `- [1:35](${VIDEO_BASE}${ID_A}?t=95) 第 2 段`,
        "",
        "",
      ].join("\n"),
    ),
    markdown,
  );
  assert.doesNotMatch(markdown, /坏数据/);
});

test("只有 UP 主分段也能导出学习稿", () => {
  const markdown = learning({ videoKey: KEY_A, creatorChapters: [{ title: "开场", start: 0 }] });
  assert.match(markdown, /## UP 主分段/);
  assert.equal(learning({ creatorChapters: [] }), "");
});

const HTML = '<img src=x onerror="alert(document.domain)">';
const LINK = "[点此登录领取大会员](https://login.example)";
const ESCAPED_HTML = '\\<img src=x onerror="alert(document.domain)"\\>';
const ESCAPED_LINK = "\\[点此登录领取大会员\\](https://login.example)";

// 去掉 YAML 头：头里的标题是加了引号的 YAML 字符串，不按 Markdown 渲染。
const body = (markdown: string): string => markdown.split("\n---\n").slice(1).join("\n---\n");

// 没被反斜杠转义的尖括号标签或方括号链接。
function assertNoRawMarkup(markdown: string): void {
  assert.equal(/(^|[^\\])<(img|iframe|script)/.test(markdown), false, markdown);
  assert.equal(/(^|[^\\])\[点此登录/.test(markdown), false, markdown);
}

test("学习稿：官方总结、UP 主分段里的 HTML 和链接语法都转义", () => {
  const markdown = learning({
    title: `正常标题 ${HTML}`,
    author: "UP",
    videoKey: KEY_A,
    creatorChapters: [{ start: 10, title: `第一章 ${LINK}` }],
    officialSummary: {
      summary: `官方总结 ${HTML}`,
      outline: [{ title: `提纲 ${LINK}`, timestamp: 5, points: [{ timestamp: 6, content: `要点 ${HTML}` }] }],
    },
  });
  const text = body(markdown);
  assertNoRawMarkup(text);
  assert.ok(text.includes(`官方总结 ${ESCAPED_HTML}`), text);
  assert.ok(text.includes(`第一章 ${ESCAPED_LINK}`), text);
  assert.ok(text.includes(`提纲 ${ESCAPED_LINK}`), text);
  assert.ok(text.includes(`要点 ${ESCAPED_HTML}`), text);
  assert.ok(text.includes(`- [0:10](${VIDEO_BASE}${ID_A}?t=10) 第一章`), "扩展自己拼的时间戳链接照常是链接");
});

test("学习稿：模型写的结论、章节、金句和失败原因都转义", () => {
  const markdown = learning({
    title: "标题",
    videoKey: KEY_A,
    analysis: {
      chapters: [{ title: `章节 ${LINK}`, timestampSeconds: 0, summary: `摘要 ${HTML}` }],
      keyQuotes: [{ quote: `金句 ${HTML}\n第二行 ${LINK}`, timestampSeconds: 3 }],
      verdict: { summary: `结论 ${HTML}`, value: `价值 ${LINK}`, verdict: "看概览就够", reason: `理由 ${HTML}` },
    },
    analysisFailures: [{ index: 1, startSeconds: 60, endSeconds: 120, reason: `超时 ${LINK}` }],
  });
  const text = body(markdown);
  assertNoRawMarkup(text);
  for (const expected of [
    `章节 ${ESCAPED_LINK}`,
    `摘要 ${ESCAPED_HTML}`,
    `金句 ${ESCAPED_HTML}`,
    `> 第二行 ${ESCAPED_LINK}`,
    `结论 ${ESCAPED_HTML}`,
    `价值 ${ESCAPED_LINK}`,
    `理由 ${ESCAPED_HTML}`,
    `超时 ${ESCAPED_LINK}`,
  ]) {
    assert.ok(text.includes(expected), `缺少：${expected}\n${text}`);
  }
});

test("学习稿和笔记导出：笔记正文、视频标题和 UP 主都转义", () => {
  const unsafe = note({
    snapshot: { title: `标题 ${HTML}`, author: `UP ${LINK}` },
    atSec: 5,
    text: `笔记 ${LINK}\n第二行 ${HTML}`,
  });
  const exported = notesAsMarkdown([unsafe], VIDEO_BASE);
  assertNoRawMarkup(exported);
  assert.ok(exported.startsWith(`# 标题 ${ESCAPED_HTML}\n`), exported);
  assert.ok(exported.includes(`UP ${ESCAPED_LINK}`), exported);
  assert.ok(
    exported.includes(`- [0:05](${VIDEO_BASE}${ID_A}?t=5) 笔记 ${ESCAPED_LINK}\n  第二行 ${ESCAPED_HTML}`),
    exported,
  );

  const draft = body(learning({ title: "标题", videoKey: KEY_A, notes: [unsafe] }));
  assertNoRawMarkup(draft);
  assert.ok(draft.includes(`笔记 ${ESCAPED_LINK}`), draft);
});

test("没有特殊字符的文字原样输出", () => {
  const exported = notesAsMarkdown(
    [note({ snapshot: { title: "普通标题", author: "" }, atSec: 65, text: "普通的一句话。" })],
    VIDEO_BASE,
  );
  assert.ok(exported.includes(`- [1:05](${VIDEO_BASE}${ID_A}?t=65) 普通的一句话。`), exported);
  assert.ok(exported.startsWith("# 普通标题\n"));
});

const CHAPTER = { chapters: [{ timestampSeconds: 10, title: "章" }], keyQuotes: [] };

test("学习稿的视频键不加引号，键可以来自任一站", () => {
  assert.match(learning({ videoKey: KEY_B, analysis: CHAPTER }), new RegExp(`^videoKey: ${KEY_B}$`, "m"));
  assert.match(learning({ videoKey: KEY_YOUTUBE, analysis: CHAPTER }), new RegExp(`^videoKey: ${KEY_YOUTUBE}$`, "m"));
});

test("没有视频键或键认不出时，文件头写空值，内容不带链接", () => {
  const missing = learning({ analysis: CHAPTER });
  assert.match(missing, /^title: 未命名视频$/m);
  assert.match(missing, /^videoKey: ""$/m);
  assert.match(missing, /^url: ""$/m);
  assert.match(missing, /^- 0:10 章$/m);

  const odd = learning({ videoKey: "坏: 键" as VideoKey, analysis: CHAPTER });
  assert.match(odd, /^title: "坏: 键"$/m);
  assert.match(odd, /^videoKey: ""$/m);
});

test("地址前缀只对 B 站的键拼链接", () => {
  const exported = notesAsMarkdown([note({ video: KEY_YOUTUBE, atSec: 65, text: "一句" })], VIDEO_BASE);
  assert.equal(exported, "# sample\\_id\n\n- 1:05 一句\n");
});

test("笔记的时间点缺失时按 0:00 排在最前，夹着的坏记录跳过", () => {
  const list: (NoteFields | null)[] = [note({ atSec: 5, text: "后" }), null, { video: KEY_A, text: "前" }];
  assert.equal(
    notesAsMarkdown(list, VIDEO_BASE),
    [`# ${ID_A}`, "", `${VIDEO_BASE}${ID_A}`, "", `- [0:00](${VIDEO_BASE}${ID_A}) 前`, `- [0:05](${VIDEO_BASE}${ID_A}?t=5) 后`, ""].join("\n"),
  );
});
