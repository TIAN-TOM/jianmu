// 模型写的内容用哪种语言：设置项的规整、解析，提示词按语言填好，任务等价键、结果和备份记着语言，
// 翻译方向、结论截断、存进结果的固定文字跟着语言走。选中文时提示词和以前逐字节一致。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FALLBACK_ANSWER, FALLBACK_ANSWERS } from "../../../src/background/services/qa.ts";
import { targetOf } from "../../../src/background/services/translate-parts.ts";
import { extractPromptSection, langVariables, localizePrompt } from "../../../src/core/ai/prompt.ts";
import { validateVerdict, VERDICT_CLIP } from "../../../src/core/ai/verdict.ts";
import { buildBackup, readBackup } from "../../../src/core/backup/format.ts";
import type { Derived, GenInfo, OverviewRecord, QaRecord } from "../../../src/core/notes/records.ts";
import { outputLangOf, plural, resolveOutputLang } from "../../../src/core/output-lang.ts";
import { equivalenceKey } from "../../../src/core/task-keys.ts";
import { genInfo, type FrozenGen } from "../../../src/core/tasks.ts";
import { DEFAULTS, normalize } from "../../../src/shared/settings-schema.ts";
import { SAMPLE_KEY as VIDEO } from "../../helpers/sample-videos.ts";

const PROMPTS_DIR = new URL("../../../prompts/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, PROMPTS_DIR), "utf8");
// 改动之前的五份模板按小节取出来的原文（占位符未填），选中文时要和它们逐字节一致。
const BEFORE = JSON.parse(readFileSync(new URL("../../fixtures/golden/prompts-zh.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

test("语言设置解析：选了哪种就用哪种；跟随浏览器时繁体的写法算繁体，其余以 zh 开头算简体，别的算英文", () => {
  assert.equal(resolveOutputLang("zh", "en-US"), "zh");
  assert.equal(resolveOutputLang("zh", "zh-TW"), "zh");
  assert.equal(resolveOutputLang("zh-Hant", "en-US"), "zh-Hant");
  assert.equal(resolveOutputLang("zh-Hant", "zh-CN"), "zh-Hant");
  assert.equal(resolveOutputLang("en", "zh-CN"), "en");
  assert.equal(resolveOutputLang("en", "zh-TW"), "en");
  for (const ui of ["zh", "zh-CN", "zh_CN", "ZH-cn", "zh-SG", "zh-Hans", "zh-Hans-HK", " zh-CN "]) assert.equal(resolveOutputLang("auto", ui), "zh", ui);
  for (const ui of ["zh-TW", "zh_TW", "zh-tw", "zh-HK", "zh_HK", "ZH-hk", "zh-MO", "zh_mo", "zh-Hant", "zh-hant", "zh_Hant", "zh-Hant-TW", "zh-Hant-HK", "zh_Hant_MO", " zh-TW "]) {
    assert.equal(resolveOutputLang("auto", ui), "zh-Hant", ui);
  }
  for (const ui of ["en-US", "en", "ja", "fr-FR", "", "zhx", "zh-TWX", "zhHant", "en-TW", "zh-Hantx"]) assert.equal(resolveOutputLang("auto", ui), ui.startsWith("zh-") ? "zh" : "en", ui);
});

test("结果或任务记下的语言：没有、认不出的一律当简体", () => {
  assert.equal(outputLangOf(undefined), "zh");
  assert.equal(outputLangOf(null), "zh");
  assert.equal(outputLangOf({}), "zh");
  assert.equal(outputLangOf({ outputLang: "en" }), "en");
  assert.equal(outputLangOf({ outputLang: "zh-Hant" }), "zh-Hant");
  assert.equal(outputLangOf({ outputLang: "zh-hant" as never }), "zh");
  assert.equal(outputLangOf({ outputLang: "zh-TW" as never }), "zh");
  assert.equal(outputLangOf({ outputLang: "fr" as never }), "zh");
});

test("设置规整：默认跟随浏览器；旧设置没有这一项、写成认不出的值都按跟随浏览器", () => {
  assert.equal(DEFAULTS.language, "auto");
  assert.equal(normalize({}).language, "auto");
  for (const bad of ["fr", "", null, 1, true, { zh: true }, "zh-TW", "zh-hant", "zh_Hant", "Hant"]) assert.equal(normalize({ language: bad }).language, "auto", String(bad));
  assert.equal(normalize({ language: "zh" }).language, "zh");
  assert.equal(normalize({ language: "zh-Hant" }).language, "zh-Hant");
  assert.equal(normalize({ language: "en" }).language, "en");
});

const LOCALIZED = ["skim/verdict.md", "skim/chapters.md", "common/qa.md", "study/explain.md", "study/frame-explain.md"];

for (const file of LOCALIZED) {
  test(`${file}：选中文时每个小节和改动前逐字节一致`, () => {
    const zh = localizePrompt(read(file), "zh");
    for (const [heading, before] of Object.entries(BEFORE[file] ?? {})) assert.equal(extractPromptSection(zh, heading, {}), before, `${file}#${heading}`);
  });

  test(`${file}：英文取英文规则那一节，两节的项一一对应，每项都用上了，填完不留语言占位符`, () => {
    const markdown = read(file);
    const zh = langVariables(markdown, "zh");
    const en = langVariables(markdown, "en");
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    const english = localizePrompt(markdown, "en");
    const sections = Object.keys(BEFORE[file] ?? {}).map((heading) => extractPromptSection(english, heading, {}));
    const joined = sections.join("\n");
    for (const [name, value] of Object.entries(en)) {
      assert.ok(joined.includes(value), `${file} 的英文规则 ${name} 没有填进去`);
      assert.ok(markdown.includes(`{${name}}`), `${file} 没有用到 {${name}}`);
    }
    const left = [...joined.matchAll(PLACEHOLDER)].map((match) => match[1]);
    for (const name of Object.keys(en)) assert.ok(!left.includes(name), `${file} 残留 {${name}}`);
    assert.notEqual(joined, Object.values(BEFORE[file] ?? {}).join("\n"));
    assert.doesNotMatch(joined, /简体中文/, "英文规则里不再要求写中文");
  });
}

test("英文规则写明协议性的标识照原样输出：结论星级、JSON 的键、出处格式", () => {
  assert.match(langVariables(read("skim/verdict.md"), "en").langLine ?? "", /verdict.*整数.*原样写「信息不足」.*JSON 的键不变/);
  assert.match(langVariables(read("skim/chapters.md"), "en").langLine ?? "", /JSON 的键不变/);
  assert.match(langVariables(read("common/qa.md"), "en").langLine ?? "", /【12:05\|原文】.*照原样/);
});

test("选英文时系统提示词要求不猜说话人的性别，选中文时没有这一条", () => {
  const rule = /没有写明说话人的性别时，不要用 he、she/;
  for (const file of LOCALIZED) {
    assert.match(extractPromptSection(localizePrompt(read(file), "en"), "系统提示词", {}), rule, file);
    assert.doesNotMatch(extractPromptSection(localizePrompt(read(file), "zh"), "系统提示词", {}), rule, file);
  }
});

test("没有语言小节的模板原样交回；整理字幕和笔记润色不套输出语言", () => {
  assert.equal(localizePrompt("## 系统提示词\n\n```\n{x}\n```\n", "en"), "## 系统提示词\n\n```\n{x}\n```\n");
  for (const file of ["study/tidy.md", "study/note-polish.md"]) assert.equal(localizePrompt(read(file), "en"), read(file));
});

const GEN: FrozenGen = { feature: "analysis", baseUrl: "https://ai.example.test/v1", model: "m", effort: "off", promptVersion: "p1" };

test("等价键随写内容的语言变：两种语言的同类任务不合并；同一种语言照旧合并", async () => {
  const key = (gen: FrozenGen) => equivalenceKey({ kind: "overview", video: VIDEO, gen });
  const zh = await key({ ...GEN, outputLang: "zh" });
  assert.notEqual(zh, await key({ ...GEN, outputLang: "en" }));
  assert.equal(zh, await key({ ...GEN, outputLang: "zh" }));
});

test("随结果存下的生成配置带上语言；任务没记语言时不写", () => {
  assert.deepEqual(genInfo({ ...GEN, outputLang: "en" }), { feature: "analysis", promptVersion: "p1", model: "m", effort: "off", outputLang: "en" });
  assert.deepEqual(genInfo(GEN), { feature: "analysis", promptVersion: "p1", model: "m", effort: "off" });
});

const BASIS = { source: "transcript", transcript: { video: VIDEO, kind: "human", lang: "en", fingerprint: "0123456789abcdef" } } as const;
const derived = (gen: GenInfo): Derived => ({ basis: BASIS, gen });
const LONG_SUMMARY = `${"word ".repeat(100).trim()}.`;

const OVERVIEW: OverviewRecord = {
  schemaVersion: 1,
  videoKey: VIDEO,
  snapshot: { title: "Sample talk", author: "Sample channel" },
  analysis: {
    chapters: [{ title: "Opening", summary: "Why plans fail", timestampSeconds: 0, timestamp: "0:00" }],
    keyQuotes: [],
    verdict: { summary: LONG_SUMMARY, value: "A three-step method", verdict: 3, reason: "Concrete examples" },
  },
  parts: {
    chapters: { derived: derived({ feature: "analysis", promptVersion: "p1", model: "m", effort: "off", outputLang: "en" }), taskCreatedAt: 10 },
    verdict: { derived: derived({ feature: "verdict", promptVersion: "p2", model: "m", effort: "off", outputLang: "en" }), taskCreatedAt: 10 },
  },
  updatedAt: 20,
};

const QA: QaRecord = {
  id: "qa_sample-en",
  video: VIDEO,
  question: "How deep?",
  answer: FALLBACK_ANSWERS.en,
  citations: [],
  clickable: [],
  derived: derived({ feature: "qa", promptVersion: "p3", model: "m", effort: "off", outputLang: "en" }),
  createdAt: 30,
};

test("备份导出再导入：语言原样留着；英文结论按英文的上限截，不被中文的 200 字截短", () => {
  const backup = buildBackup({ overviews: [OVERVIEW], qa: [QA] }, Date.UTC(2026, 10, 20));
  const result = readBackup(JSON.parse(JSON.stringify(backup)));
  assert.ok(result.ok);
  const [overview] = result.value.contents.overviews;
  const [qa] = result.value.contents.qa;
  assert.deepEqual(overview, OVERVIEW);
  assert.deepEqual(qa, QA);
  assert.ok(LONG_SUMMARY.length > VERDICT_CLIP.zh.summary);
});

test("备份里认不出的语言当没写，读的时候按中文；旧备份没有这一项照常导入", () => {
  const odd = { ...QA, derived: derived({ feature: "qa", promptVersion: "p3", model: "m", effort: "off", outputLang: "fr" as never }) };
  const legacy = { ...QA, id: "qa_sample-old", derived: derived({ feature: "qa", promptVersion: "p3", model: "m", effort: "off" }) };
  const result = readBackup(JSON.parse(JSON.stringify(buildBackup({ qa: [odd, legacy] }, 0))));
  assert.ok(result.ok);
  for (const record of result.value.contents.qa) {
    assert.ok(record.derived.gen);
    assert.equal("outputLang" in record.derived.gen, false);
    assert.equal(outputLangOf(record.derived.gen), "zh");
  }
});

test("结论截断：中文照旧按 200、120、120 字截；英文另给一组更宽的上限，不截成半句", () => {
  const long = (n: number) => "x".repeat(n);
  const raw = { summary: long(1000), value: long(1000), reason: long(1000), verdict: 3 };
  const zh = validateVerdict(raw);
  assert.deepEqual([zh?.summary.length, zh?.value.length, zh?.reason.length], [200, 120, 120]);
  const en = validateVerdict(raw, { lang: "en" });
  assert.deepEqual([en?.summary.length, en?.value.length, en?.reason.length], [VERDICT_CLIP.en.summary, VERDICT_CLIP.en.value, VERDICT_CLIP.en.reason]);
  // 提示词要求 50 个英文词和 30 个英文词以内：按一个词连空格六七个字符算，上限留出一倍多。
  assert.ok(VERDICT_CLIP.en.summary >= 50 * 7 * 2);
  assert.ok(VERDICT_CLIP.en.value >= 30 * 7 * 2 && VERDICT_CLIP.en.reason >= 30 * 7 * 2);
  const sentence = "The talk walks through three planning mistakes and shows how a weekly review fixes each one with real examples.";
  assert.equal(validateVerdict({ summary: sentence, verdict: 3 }, { lang: "en" })?.summary, sentence);
});

test("翻译方向：译成设置的语言，字幕本身已经是这种语言时译成另一种；选中文时和以前一样", () => {
  assert.equal(targetOf("zh-CN", "zh"), "en");
  assert.equal(targetOf("ai-zh", "zh"), "en");
  assert.equal(targetOf("en-US", "zh"), "zh");
  assert.equal(targetOf("ja", "zh"), "zh");
  assert.equal(targetOf("", "zh"), "en", "拿不到语言码按中文字幕");
  assert.equal(targetOf("zh-CN", "en"), "en");
  assert.equal(targetOf("ja", "en"), "en");
  assert.equal(targetOf("en", "en"), "zh");
  assert.equal(targetOf("ai-en", "en"), "zh");
  assert.equal(targetOf("en-GB"), "zh", "不给语言时按中文");
});

test("问答的兜底回答按语言存；中文那句和以前一样", () => {
  assert.equal(FALLBACK_ANSWERS.zh, FALLBACK_ANSWER);
  assert.doesNotMatch(FALLBACK_ANSWERS.en, /\p{Script=Han}/u);
});

test("英文的数量加名词：1 用单数，0 和别的数用复数", () => {
  assert.equal(plural(1, "video", "videos"), "1 video");
  assert.equal(plural(0, "video", "videos"), "0 videos");
  assert.equal(plural(3, "video", "videos"), "3 videos");
});
