// 模型写繁体：提示词按繁体中文规则那一节填，简体和英文收到的提示词和加这一节之前逐字相同；
// 档位、引用照抄原文的规矩写进规则，模型没照做时本机兜住：繁体档位认回原档位，转成繁体的引用对不上就丢掉那一行。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { extractPromptSection, LANG_SECTIONS, langVariables, localizePrompt } from "../../../src/core/ai/prompt.ts";
import { alignTranslatedSegments, chunkFromModel, looksLikeTranslation, validateAnalysis } from "../../../src/core/ai/validate.ts";
import { LEGACY_VERDICT, onlyHanVariant, validateVerdict, verdictLabelOf, verdictName } from "../../../src/core/ai/verdict.ts";
import { groundQaAnswer } from "../../../src/core/qa/citations.ts";

const PROMPTS_DIR = new URL("../../../prompts/", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, PROMPTS_DIR), "utf8");
// 加繁体那一节之前，简体和英文拼出来的各小节（语言占位符已填，其余占位符未填；翻译的语言规则已填进 {langRules}）。
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

test("简体和英文：六份提示词拼出来的每个小节和加繁体那一节之前逐字相同", () => {
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

test("繁体规则写明：档位照抄四个简体词，不跟着转成繁体", () => {
  const line = langVariables(read("skim/verdict.md"), "zh-Hant").langLine ?? "";
  for (const label of ["推荐看", "可以看", "可跳过", "信息不足"]) assert.ok(line.includes(`「${label}」`), label);
  assert.match(line, /不要因为全文是繁体就把这四个词转成繁体/);
  assert.match(line, /JSON 的键不变/);
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

test("档位写成繁体：认回原来的档位；「信息不足」和「資訊不足」都认", () => {
  const cases: readonly [string, string][] = [
    ["推薦看", "推荐看"],
    ["可以看", "可以看"],
    ["可跳過", "可跳过"],
    ["資訊不足", "信息不足"],
    ["信息不足", "信息不足"],
    [" 推薦看 ", "推荐看"],
    ["看概覽就夠", LEGACY_VERDICT],
    ["推荐看", "推荐看"],
    ["還行", ""],
  ];
  for (const [raw, label] of cases) assert.equal(verdictLabelOf(raw), label, raw);
});

test("模型在繁体下写了繁体档位：结论照收，存的是原来的简体档位；旧版那一档照旧不收", () => {
  const base = { summary: "這部影片講了三個做法。", value: "一個做法", reason: "8:20 那章的推導" };
  for (const [raw, label] of [["推薦看", "推荐看"], ["可跳過", "可跳过"], ["資訊不足", "信息不足"], ["信息不足", "信息不足"], ["可以看", "可以看"]] as const) {
    const verdict = validateVerdict({ ...base, verdict: raw }, { lang: "zh-Hant" });
    assert.equal(verdict?.verdict, label, raw);
    assert.equal(verdict?.reason, base.reason, `${raw} 的理由留着`);
    assert.equal(verdictName(verdict?.verdict ?? "", "zh-Hant"), verdictName(label, "zh-Hant"));
  }
  assert.equal(validateVerdict({ ...base, verdict: "看概覽就夠" }, { lang: "zh-Hant" })?.verdict, "");
  assert.equal(validateVerdict({ ...base, verdict: "看概覽就夠" }, { lang: "zh-Hant", stored: true })?.verdict, LEGACY_VERDICT);
});

// ============================================================
// 本机兜底：标题译名
// ============================================================

test("只换了字形：逐字比，长度一样、不同的地方两边都是汉字", () => {
  assert.equal(onlyHanVariant("三個做法讓番茄長得更好", "三个做法让番茄长得更好"), true);
  assert.equal(onlyHanVariant("用 Python 寫爬蟲", "用 Python 写爬虫"), true);
  assert.equal(onlyHanVariant("番茄種植", "番茄种植"), true);
  assert.equal(onlyHanVariant("番茄种植", "番茄种植"), false, "一模一样的交给原来的比较");
  assert.equal(onlyHanVariant("東京的觀光", "東京の観光"), false, "假名换成了汉字，是真译");
  assert.equal(onlyHanVariant("番茄怎麼種", "How to grow tomatoes"), false);
  assert.equal(onlyHanVariant("三個做法", "三个做法！"), false, "长度不一样");
});

test("选繁体时把中文标题转成繁体当译名：本机当没有；外文标题的繁体译名照收；简体和英文的规矩不变", () => {
  const verdict = (translatedTitle: string, title: string, lang: "zh" | "zh-Hant" | "en") =>
    validateVerdict({ summary: "摘要", verdict: "可以看", translatedTitle }, { lang, title })?.translatedTitle;
  assert.equal(verdict("三個做法讓番茄長得更好", "三个做法让番茄长得更好", "zh-Hant"), undefined);
  assert.equal(verdict("三个做法让番茄长得更好", "三个做法让番茄长得更好", "zh-Hant"), undefined);
  assert.equal(verdict("番茄怎麼種才能長得好", "How to grow better tomatoes", "zh-Hant"), "番茄怎麼種才能長得好");
  assert.equal(verdict("東京的觀光指南", "東京の観光ガイド", "zh-Hant"), "東京的觀光指南");
  // 简体下这一条不管：换了字形的照旧按原来的比较收下。
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
