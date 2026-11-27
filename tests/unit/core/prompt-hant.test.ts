// 模型按繁体中文规则写，兼容旧结论里的繁体档位；出处还要对得上字幕原文。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extractPromptSection, LANG_SECTIONS, langVariables, localizePrompt } from "../../../src/core/ai/prompt.ts";
import { alignTranslatedSegments, chunkFromModel, looksLikeTranslation, validateAnalysis } from "../../../src/core/ai/validate.ts";
import { validateVerdict, verdictLabelOf } from "../../../src/core/ai/verdict.ts";
import { groundQaAnswer } from "../../../src/core/qa/citations.ts";

const PROMPTS_DIR = new URL("../../../prompts/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, PROMPTS_DIR), "utf8");
// 简体和英文拼出来的各小节（语言占位符已填，其余占位符未填；翻译的语言规则已填进 {langRules}）。
const BEFORE = JSON.parse(readFileSync(new URL("../../fixtures/golden/prompts-zh-en.json", import.meta.url), "utf8")) as Record<"zh" | "en", Record<string, Record<string, string>>>;
const LOCALIZED = ["skim/verdict.md", "skim/chapters.md", "common/qa.md", "study/explain.md", "study/frame-explain.md"];
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const TRANSLATION_NAMES = { zh: "简体中文", en: "英文" } as const;

/** 按服务的拼法拼出某种语言下的各小节。 */
function sectionsIn(file: string, lang: "zh" | "zh-Hant" | "en", headings: readonly string[]): Record<string, string> {
  const markdown = read(file);
  if (file === "study/translation.md") {
    const variables = { targetLangName: lang === "zh-Hant" ? "繁体中文" : TRANSLATION_NAMES[lang], langRules: extractPromptSection(markdown, LANG_SECTIONS[lang]) };
    return Object.fromEntries(headings.map((heading) => [heading, extractPromptSection(markdown, heading, variables)]));
  }
  const localized = localizePrompt(markdown, lang);
  return Object.fromEntries(headings.map((heading) => [heading, extractPromptSection(localized, heading, {})]));
}

test("简体和英文：六份提示词拼出来的每个小节和黄金样本逐字相同", () => {
  for (const lang of ["zh", "en"] as const) {
    const files = BEFORE[lang];
    assert.deepEqual(Object.keys(files).sort(), [...LOCALIZED, "study/translation.md"].sort());
    for (const [file, sections] of Object.entries(files)) {
      assert.deepEqual(sectionsIn(file, lang, Object.keys(sections)), sections, `${lang} ${file}`);
    }
  }
});

test("快照里的简体那份和更早的简体快照一致", () => {
  const older = JSON.parse(readFileSync(new URL("../../fixtures/golden/prompts-zh.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;
  for (const [file, sections] of Object.entries(older)) assert.deepEqual(BEFORE.zh[file], sections, file);
});

test("繁体取繁体中文规则那一节：和中文规则的项一一对应，都填进去了，不带中文规则那一节独有的说法，不留语言占位符", () => {
  assert.equal(LANG_SECTIONS["zh-Hant"], "繁体中文规则");
  for (const file of LOCALIZED) {
    const markdown = read(file);
    const zh = langVariables(markdown, "zh");
    const hant = langVariables(markdown, "zh-Hant");
    assert.deepEqual(Object.keys(hant).sort(), Object.keys(zh).sort(), file);
    const joined = Object.values(sectionsIn(file, "zh-Hant", Object.keys(BEFORE.zh[file] ?? {}))).join("\n");
    for (const [name, value] of Object.entries(hant)) assert.ok(joined.includes(value), `${file} 的繁体规则 ${name} 没有填进去`);
    for (const [name, value] of Object.entries(zh)) {
      if (value !== hant[name]) assert.ok(!joined.includes(value), `${file} 繁体下还带着中文规则的 ${name}`);
    }
    const left = [...joined.matchAll(PLACEHOLDER)].map((match) => match[1]);
    for (const name of Object.keys(hant)) assert.ok(!left.includes(name), `${file} 残留 {${name}}`);
    assert.doesNotMatch(joined, /简体中文/, `${file} 繁体下不再要求写简体`);
    assert.match(joined, /繁体中文/, file);
    // 繁体也不猜性别那一条是英文专有的，不带过来。
    assert.doesNotMatch(joined, /不要用 he、she/, file);
  }
});

test("繁体的翻译规则：译成繁体中文，带繁体那一节，不带中文规则那一节独有的说法", () => {
  const system = sectionsIn("study/translation.md", "zh-Hant", ["系统提示词"])["系统提示词"] ?? "";
  assert.match(system, /^你在给视频字幕做翻译，译成繁体中文。/);
  assert.ok(system.includes(extractPromptSection(read("study/translation.md"), "繁体中文规则")));
  assert.ok(!system.includes("「用 Python 写」"), "简体的示例没带过来");
  assert.match(system, /台湾/);
  assert.doesNotMatch(system, /\{langRules\}|\{targetLangName\}/);
});

test("繁体规则写明星数和信息不足的写法，JSON 键照旧", () => {
  for (const file of ["skim/verdict.md", "skim/verdict-comments.md"]) {
    const line = langVariables(read(file), "zh-Hant").langLine ?? "";
    assert.match(line, /verdict 用整数或原样写「信息不足」/);
    assert.match(line, /JSON 的键不变/);
  }
});

test("繁体规则写明：出处里的原文照字幕抄，简体不转繁体；规则里的示例本机核对得上", () => {
  const line = langVariables(read("common/qa.md"), "zh-Hant").langLine ?? "";
  assert.match(line, /【12:05\|原文】/);
  assert.match(line, /字幕是简体就写简体，不要转成繁体/);
  const example = /就写「(.+?)」：/.exec(line)?.[1] ?? "";
  assert.ok(example, "规则里带一句示范");
  const grounded = groundQaAnswer(example, [{ start: 184, text: "这个方法其实很简单" }]);
  assert.equal(grounded.answer, "這個方法其實很簡單。[3:04]");
  assert.deepEqual(grounded.citations, [{ startSeconds: 184, quote: "这个方法其实很简单" }]);
});

test("繁体规则写明：金句用繁体写、只换字形不改用词；选中的原文和画面里的字照原样写，简体不转繁体；专有名词不换成台湾译名", () => {
  const chapters = langVariables(read("skim/chapters.md"), "zh-Hant");
  assert.match(chapters.quoteLang ?? "", /原话是中文时用繁体写：字幕是简体就只把字换成繁体，话还是说话人的原话，不改用词/);
  assert.match(chapters.quoteLang ?? "", /原话是外语时，译成通顺的繁体中文/);
  assert.match(chapters.langLine ?? "", /所有文字用繁体中文/);
  assert.doesNotMatch(chapters.langLine ?? "", /例外|不跟着全文转成繁体/);
  assert.match(langVariables(read("study/explain.md"), "zh-Hant").langLine ?? "", /原文是简体就写简体，不要转成繁体/);
  assert.match(langVariables(read("study/frame-explain.md"), "zh-Hant").foreignText ?? "", /简体字照写简体，不要转成繁体/);
  for (const file of LOCALIZED) {
    const all = Object.values(langVariables(read(file), "zh-Hant")).join("\n");
    assert.match(all, /台湾/, file);
    assert.match(all, /不要改成台湾的另一种译名/, file);
  }
});

test("繁体规则写明：标题是中文（不分简繁）就不给译名，不把简体标题转成繁体当译名", () => {
  const rule = langVariables(read("skim/verdict.md"), "zh-Hant").titleRule ?? "";
  assert.match(rule, /不管是简体还是繁体.*都给空字符串/);
  assert.match(rule, /不要把简体标题转成繁体当译名/);
  assert.match(rule, /译成繁体中文/);
});

// ============================================================
// 本机兜底：档位
// ============================================================

test("读旧记录时认得繁体档位和早期的名称，模型新输出里的旧名一律丢掉", () => {
  for (const [raw, stars] of [
    [" 推薦看 ", 5], ["可以看", 3], ["可跳過", 1],
    ["看概覽就夠", 2], ["值得看完整視頻", 5], ["值得看完整影片", 5], ["可以跳過", 1],
  ] as const) {
    const record = { summary: "摘要", verdict: raw, reason: "理由" };
    assert.equal(verdictLabelOf(raw), stars, raw);
    assert.equal(validateVerdict(record, { lang: "zh-Hant", stored: true })?.verdict, stars);
    assert.equal(validateVerdict(record, { lang: "zh-Hant" })?.verdict, "");
  }
});

test("模型回繁体的信息不足时保留理由，读旧记录也认同一写法", () => {
  const record = { summary: "摘要", value: "", verdict: " 資訊不足 ", reason: "缺了後半段" };
  for (const stored of [false, true]) {
    assert.deepEqual(validateVerdict(record, { lang: "zh-Hant", stored }), { ...record, verdict: "信息不足" });
  }
});

// ============================================================
// 标题译名
// ============================================================

test("选繁体时外文标题的繁体译名照收，全是汉字的日文标题译成等长的繁体也照收；和原标题一样的不收；简体和英文的规矩不变", () => {
  const verdict = (translatedTitle: string, title: string, lang: "zh" | "zh-Hant" | "en") =>
    validateVerdict({ summary: "摘要", verdict: 3, translatedTitle }, { lang, title })?.translatedTitle;
  assert.equal(verdict("番茄怎麼種才能長得好", "How to grow better tomatoes", "zh-Hant"), "番茄怎麼種才能長得好");
  assert.equal(verdict("東京的觀光指南", "東京の観光ガイド", "zh-Hant"), "東京的觀光指南");
  assert.equal(verdict("東京觀光", "東京観光", "zh-Hant"), "東京觀光");
  assert.equal(verdict("三个做法让番茄长得更好", "三个做法让番茄长得更好", "zh-Hant"), undefined);
  assert.equal(verdict("三个做法让番茄长得更好", "三個做法讓番茄長得更好", "zh"), "三个做法让番茄长得更好");
  assert.equal(verdict("Three ways to grow tomatoes", "种番茄的三个做法", "en"), "Three ways to grow tomatoes");
});

// ============================================================
// 本机兜底：问答引用（比对规则不变，宁可少答）
// ============================================================

const ENTRIES = [
  { start: 184, text: "这个方法其实很简单" },
  { start: 492, text: "第二步要先浇水" },
];

test("字幕是简体、回答是繁体、引用照抄简体原文：引用成立", () => {
  const grounded = groundQaAnswer("方法很簡單。【3:04|这个方法其实很简单】\n第二步先澆水。【8:12|第二步要先浇水】", ENTRIES);
  assert.equal(grounded.answer, "方法很簡單。[3:04]\n第二步先澆水。[8:12]");
  assert.deepEqual(grounded.citations, [
    { startSeconds: 184, quote: "这个方法其实很简单" },
    { startSeconds: 492, quote: "第二步要先浇水" },
  ]);
});

test("引用被转成繁体：那一行丢掉，不出现对不上的引用；全都转了时没有引用，服务会换成兜底回答", () => {
  const mixed = groundQaAnswer("方法很簡單。【3:04|這個方法其實很簡單】\n第二步先澆水。【8:12|第二步要先浇水】", ENTRIES);
  assert.equal(mixed.answer, "第二步先澆水。[8:12]");
  assert.deepEqual(mixed.citations, [{ startSeconds: 492, quote: "第二步要先浇水" }]);

  const converted = groundQaAnswer("方法很簡單。【3:04|這個方法其實很簡單】\n第二步先澆水。【8:12|第二步要先澆水】", ENTRIES);
  assert.equal(converted.answer, "");
  assert.deepEqual(converted.citations, []);
});

// ============================================================
// 其他校验在繁体输出下不误判
// ============================================================

test("译成繁体：繁体字算中文，真译了的收下，原文抄回来的不收", () => {
  const source = "This is a fairly long English sentence about growing tomatoes.";
  assert.equal(looksLikeTranslation("這是一段關於種番茄的相當長的英文句子。", source, "zh-Hant"), true);
  assert.equal(looksLikeTranslation(source, source, "zh-Hant"), false);
  const aligned = alignTranslatedSegments({ segments: [{ id: "a", text: "這是一段關於種番茄的句子。" }, { id: "b", text: source }] }, [{ id: "a", text: source }, { id: "b", text: source }], { targetLang: "zh-Hant" });
  assert.deepEqual(aligned.translated, { a: "這是一段關於種番茄的句子。" });
  assert.deepEqual(aligned.rejected, [{ id: "b", reason: "NOT_TRANSLATED" }]);
});

test("概览分块：繁体的章节名、摘要和简体的金句照常收下", () => {
  const parsed = chunkFromModel({
    chapters: [{ start: "0:00", title: "番茄要在開花前搭架", summary: "講了三個步驟和一個例子。" }],
    keyQuotes: [{ start: "1:05", quote: "搭架要趁早" }],
  });
  assert.deepEqual(validateAnalysis(parsed, 600), {
    chapters: [{ title: "番茄要在開花前搭架", summary: "講了三個步驟和一個例子。", timestampSeconds: 0, timestamp: "0:00" }],
    keyQuotes: [{ quote: "搭架要趁早", timestampSeconds: 65, timestamp: "1:05" }],
  });
});
