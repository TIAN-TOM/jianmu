import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { extractPromptSection, fillPromptVariables, type PromptVariables } from "../../../../src/core/ai/prompt.ts";

const PROMPTS_DIR = new URL("../../../../prompts/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, PROMPTS_DIR), "utf8");

const SAMPLE_MARKDOWN = [
  "# 标题",
  "",
  "## 系统提示词",
  "",
  "```",
  "你好 {name}，时长 {duration}。",
  "```",
  "",
  "## 用户提示词",
  "",
  "```",
  "内容：{body}",
  "```",
  "",
  "## 变量",
  "",
  "- `{name}` — 名字",
].join("\n");

test("按小节标题取出代码块并替换变量", () => {
  assert.equal(
    extractPromptSection(SAMPLE_MARKDOWN, "系统提示词", {
      name: "小明",
      duration: "3:20",
    }),
    "你好 小明，时长 3:20。",
  );
  assert.equal(extractPromptSection(SAMPLE_MARKDOWN, "用户提示词", { body: "正文" }), "内容：正文");
});

test("只取本小节的代码块，不会串到下一节", () => {
  const section = extractPromptSection(SAMPLE_MARKDOWN, "系统提示词", {});
  assert.doesNotMatch(section, /内容/);
});

test("未提供的变量替换成空串，而不是留下占位符", () => {
  const section = extractPromptSection(SAMPLE_MARKDOWN, "系统提示词", {
    name: null,
    duration: undefined,
  });
  assert.equal(section, "你好 ，时长 。");
});

test("小节不存在或没有代码块时报错", () => {
  assert.throws(() => extractPromptSection(SAMPLE_MARKDOWN, "不存在"), /不存在/);
  assert.throws(() => extractPromptSection("## 空节\n\n没有代码块\n", "空节"), /代码块/);
});

test("字幕或简介里恰好写着 {变量} 时不会被再展开一次", () => {
  // 简介排在 chaptersText 前面替换：逐个 split/join 的话，简介里的
  // {chaptersText} 会在下一轮被换成章节正文。
  const user = extractPromptSection(read("verdict.md"), "用户提示词", {
    videoTitle: "标题",
    ownerName: "UP 主",
    durationFormatted: "10:00",
    videoDescription: "简介原文：本期讲 {chaptersText} 和 $& 的区别",
    chaptersText: "[0:00] 开场：讲了开场",
    quotesText: "（无）",
    coverageNote: "章节摘要和金句覆盖了全片。",
  });
  assert.ok(user.includes("简介原文：本期讲 {chaptersText} 和 $& 的区别"));
  assert.equal(user.split("[0:00] 开场：讲了开场").length - 1, 1, "章节正文只该出现在章节摘要那一处");
});

test("变量替换一次扫完：没给值的占位符和 JSON 示例原样保留", () => {
  assert.equal(fillPromptVariables('{a}+{b}={c} {"json": 1}', { a: "{b}", b: "2" }), '{b}+2={c} {"json": 1}');
  assert.equal(fillPromptVariables("{a}", { a: null }), "");
  assert.equal(fillPromptVariables("{toString}", {}), "{toString}", "原型链上的名字不算变量");
});

/**
 * 服务传的变量名与提示词文件里写的占位符必须一一对应。
 * 对不上的话不会报错，只会把 `{videoTitle}` 这样的字面量原样发给模型——
 * 输出质量悄悄变差，很难在运行时发现。
 */
const PROMPTS: Readonly<Record<string, PromptVariables>> = {
  "analysis.md": {
    startFormatted: "0:00",
    minTimestampSeconds: 0,
    durationFormatted: "10:00",
    lateThreshold: "7:30",
    maxTimestampSeconds: 600,
    videoTitle: "测试标题",
    ownerName: "测试 UP",
    videoDescription: "测试简介",
    transcriptText: "[0:00] 测试字幕",
    rangeNote: "这是第 1 / 3 段",
    contextNote: "前情回顾：[0:00] 上一段的结尾",
  },
  "explain.md": {
    videoTitle: "测试标题",
    selectedText: "测试选中",
    transcriptContext: "测试上下文",
  },
  "translation.md": {
    targetLangName: "简体中文",
    langRules: "- 测试规则",
    videoTitle: "测试标题",
    segmentsJson: '{"segments":[{"id":"s1","text":"hello"}]}',
  },
  "note-cleanup.md": {
    videoTitle: "测试标题",
    fullContext: "测试上下文",
    beforeText: "前文",
    targetText: "目标",
    afterText: "后文",
  },
  "qa.md": {
    videoTitle: "测试视频",
    ownerName: "UP 主",
    question: "用户的问题",
    transcriptText: "[0:00] 字幕句子",
  },
  "verdict.md": {
    videoTitle: "测试标题",
    ownerName: "测试 UP",
    durationFormatted: "10:00",
    videoDescription: "测试简介",
    chaptersText: "[0:00] 开场：讲了开场",
    quotesText: "[0:05] 一句金句",
    coverageNote: "章节摘要和金句覆盖了全片。",
  },
};

// 形如 {videoTitle} 的占位符。提示词里的 JSON 示例都以引号开头（{"chapters"），不会误伤。
const PLACEHOLDER = /\{[A-Za-z][A-Za-z0-9_]*\}/;

for (const [file, variables] of Object.entries(PROMPTS)) {
  test(`${file} 含有系统与用户两个提示词小节`, () => {
    const markdown = read(file);
    for (const heading of ["系统提示词", "用户提示词"]) {
      const section = extractPromptSection(markdown, heading, variables);
      assert.ok(section.trim().length > 0, `${file}#${heading} 是空的`);
    }
  });

  test(`${file} 的占位符能被完全替换`, () => {
    const markdown = read(file);
    for (const heading of ["系统提示词", "用户提示词"]) {
      const section = extractPromptSection(markdown, heading, variables);
      const leftover = section.match(PLACEHOLDER);
      assert.equal(leftover, null, `${file}#${heading} 残留未替换的占位符：${leftover?.[0]}`);
    }
  });

  test(`${file} 里的每个变量都真的被用到了`, () => {
    const markdown = read(file);
    const both = ["系统提示词", "用户提示词"]
      .map((heading) => extractPromptSection(markdown, heading, {}))
      .join("\n");
    for (const key of Object.keys(variables)) {
      assert.ok(both.includes(`{${key}}`), `${file} 没有用到服务传入的变量 {${key}}`);
    }
  });
}

test("translation.md 的两套语言规则小节都存在且非空", () => {
  // 服务按字幕语种在这两节里二选一注入 {langRules}，
  // 调用处不是字面量，上面那条扫描测试逮不到它，这里单独守。
  for (const heading of ["中文规则", "英文规则"]) {
    const rules = extractPromptSection(read("translation.md"), heading, {});
    assert.ok(rules.trim().length > 0, `translation.md#${heading} 是空的`);
  }
});

test("分批/分块任务的系统提示词保持稳定前缀，服务商缓存才能命中", () => {
  // 逐批变化的内容一旦混进系统提示词，几十个批次就要为同样的指令
  // 付几十次全价 prefill。segmentsJson 只允许出现在用户提示词里。
  const translationSystem = extractPromptSection(read("translation.md"), "系统提示词", {});
  assert.ok(!translationSystem.includes("{segmentsJson}"), "translation.md 的系统提示词不该包含逐批变化的 segmentsJson");
  // 概览分块时时长、门槛逐块不同，系统提示词必须全静态。
  const analysisSystem = extractPromptSection(read("analysis.md"), "系统提示词", {});
  assert.equal(
    analysisSystem.match(PLACEHOLDER),
    null,
    `analysis.md 系统提示词应为全静态，发现：${analysisSystem.match(PLACEHOLDER)?.[0]}`,
  );
});

const FROM_DIGEST_FOR_BILIBILI = ["analysis.md", "explain.md", "note-cleanup.md", "translation.md"];

test("来自 Digest for Bilibili 的提示词保留了署名", () => {
  for (const file of FROM_DIGEST_FOR_BILIBILI) {
    assert.match(read(file), /Digest for Bilibili/, `${file} 应写明来自 Digest for Bilibili`);
    assert.match(read(file), /youtube-digest/, `${file} 应保留 youtube-digest 的 MIT 署名`);
  }
});

test("每份提示词要么标注 Digest for Bilibili 出处，要么标注为原创", () => {
  for (const file of Object.keys(PROMPTS)) {
    const isPorted = FROM_DIGEST_FOR_BILIBILI.includes(file);
    assert.match(read(file), isPorted ? /youtube-digest/ : /原创/, `${file} 的出处没有交代清楚`);
  }
});

test("prompts/ 的源文件没有 \\r：模板按 \\n 解析", () => {
  const files = readdirSync(PROMPTS_DIR).filter((name) => name.endsWith(".md"));
  assert.deepEqual(files.sort(), Object.keys(PROMPTS).sort());
  for (const file of files) assert.ok(!read(file).includes("\r"), `${file} 含有 \\r`);
});
