// 繁体打底：按语言挑一份的回落、简繁共用的逻辑分支、错误挂着的繁体说明、记录和备份认 zh-Hant。
// 没写繁体的回落到简体；这里守的是结构，各处繁体文字的检查在各自的测试里。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fallbackAnswer, FALLBACK_ANSWERS } from "../../../src/background/services/qa.ts";
import { targetOf } from "../../../src/background/services/translate-parts.ts";
import { LANG_SECTIONS, localizePrompt } from "../../../src/core/ai/prompt.ts";
import { bothLangs, messageIn, providerText, withEnglish } from "../../../src/core/ai/provider/text.ts";
import { aiErrorResponse } from "../../../src/core/ai/transport/errors.ts";
import { transportBoth } from "../../../src/core/ai/transport/text.ts";
import { validateVerdict, VERDICT_CLIP, verdictName } from "../../../src/core/ai/verdict.ts";
import { buildBackup, readBackup } from "../../../src/core/backup/format.ts";
import { noticeLines, DATA_CONSENT_TABLE } from "../../../src/core/consent.ts";
import { describe, errorCopy } from "../../../src/core/errors.ts";
import { translationId, type QaRecord, type TranslationRecord } from "../../../src/core/notes/records.ts";
import { inLang, isChineseLang, isOutputLang, OUTPUT_LANGS, outputLangOf } from "../../../src/core/output-lang.ts";
import { equivalenceKey } from "../../../src/core/task-keys.ts";
import type { FrozenGen } from "../../../src/core/tasks.ts";
import { groupName } from "../../../src/core/triage/groups.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { HTML_LANG } from "../../../src/pages/shared/ui-lang.ts";
import { settingsCheckText } from "../../../src/shared/settings-text.ts";
import { CHECK_HANT } from "../../../src/shared/settings-text-hant.ts";
import { trackName as biliTrackName } from "../../../src/sites/bilibili/url.ts";
import { trackName as youtubeTrackName } from "../../../src/sites/youtube/url.ts";

test("inLang：三种语言各取各的那份，繁体那份是空串、null 也照用", () => {
  assert.equal(inLang("zh", "简", "en", "繁"), "简");
  assert.equal(inLang("en", "简", "en", "繁"), "en");
  assert.equal(inLang("zh-Hant", "简", "en", "繁"), "繁");
  assert.equal(inLang("zh-Hant", "简", "en", ""), "");
  assert.equal(inLang<string | null>("zh-Hant", "简", "en", null), null);
});

test("三种语言的取值：简繁共用中文那条路，记录里只认这三个写法", () => {
  assert.deepEqual([...OUTPUT_LANGS], ["zh", "zh-Hant", "en"]);
  assert.deepEqual(OUTPUT_LANGS.map(isChineseLang), [true, true, false]);
  for (const bad of ["zh-TW", "zh-hant", "Hant", "auto", "", null]) assert.equal(isOutputLang(bad), false, String(bad));
});

test("翻译方向：选繁体时中文字幕（不分简繁）译成英文，别的语言译成繁体", () => {
  for (const lang of ["zh-CN", "zh-TW", "zh-Hant", "zh-Hans", "ai-zh", ""]) assert.equal(targetOf(lang, "zh-Hant"), "en", lang);
  for (const lang of ["en", "en-US", "ja", "ko", "ai-en"]) assert.equal(targetOf(lang, "zh-Hant"), "zh-Hant", lang);
  // 选英文时英文字幕照旧译成简体。
  assert.equal(targetOf("en", "en"), "zh");
});

test("提示词：繁体有自己那一节，填出来和简体不一样；结论截断和简体同一组上限", () => {
  assert.notEqual(LANG_SECTIONS["zh-Hant"], LANG_SECTIONS.zh);
  const prompts = new URL("../../../prompts/", import.meta.url);
  for (const file of ["skim/verdict.md", "skim/chapters.md", "common/qa.md", "study/explain.md", "study/frame-explain.md"]) {
    const markdown = readFileSync(new URL(file, prompts), "utf8");
    assert.notEqual(localizePrompt(markdown, "zh-Hant"), localizePrompt(markdown, "zh"), file);
  }
  assert.deepEqual(VERDICT_CLIP["zh-Hant"], VERDICT_CLIP.zh);
  const raw = { summary: "x".repeat(1000), value: "x".repeat(1000), reason: "x".repeat(1000), verdict: "可以看" };
  assert.deepEqual(validateVerdict(raw, { lang: "zh-Hant" }), validateVerdict(raw, { lang: "zh" }));
});

const GEN: FrozenGen = { feature: "analysis", baseUrl: "https://ai.example.test/v1", model: "m", effort: "off", promptVersion: "p1" };
const VIDEO = videoKey({ platform: "bilibili", videoId: "BV1Sample000" });

test("等价键：繁体和简体的同类任务不合并", async () => {
  const key = (gen: FrozenGen) => equivalenceKey({ kind: "overview", video: VIDEO, gen });
  assert.notEqual(await key({ ...GEN, outputLang: "zh" }), await key({ ...GEN, outputLang: "zh-Hant" }));
  assert.equal(await key({ ...GEN, outputLang: "zh-Hant" }), await key({ ...GEN, outputLang: "zh-Hant" }));
});

const TRANSCRIPT = { video: VIDEO, kind: "human" as const, lang: "en", fingerprint: "0123456789abcdef" };

test("备份：记着繁体的结果和繁体的译文导出再导入原样留着，读回来是繁体", () => {
  const qa: QaRecord = {
    id: "qa_sample-hant",
    video: VIDEO,
    question: "樣例問題",
    answer: fallbackAnswer("zh-Hant"),
    citations: [],
    clickable: [],
    derived: { basis: { source: "transcript", transcript: TRANSCRIPT }, gen: { feature: "qa", promptVersion: "p3", model: "m", effort: "off", outputLang: "zh-Hant" } },
    createdAt: 30,
  };
  const translation: TranslationRecord = {
    id: translationId(TRANSCRIPT, "zh-Hant"),
    video: VIDEO,
    transcript: TRANSCRIPT,
    target: "zh-Hant",
    segments: { a1a1a1a1a1a1a1a1: "樣例譯文。" },
    derived: { basis: { source: "transcript", transcript: TRANSCRIPT }, gen: { feature: "translation", promptVersion: "v1", model: "m", effort: "off", outputLang: "zh-Hant" } },
    updatedAt: 40,
  };
  const result = readBackup(JSON.parse(JSON.stringify(buildBackup({ qa: [qa], translations: [translation] }, 0))));
  assert.ok(result.ok);
  assert.deepEqual(result.value.contents.qa, [qa]);
  assert.deepEqual(result.value.contents.translations, [translation]);
  assert.equal(outputLangOf(result.value.contents.qa[0]?.derived.gen), "zh-Hant");
  // 写法不对的目标语言照旧跳过。
  const bad = readBackup(JSON.parse(JSON.stringify({ ...buildBackup({ translations: [translation] }, 0), translations: [{ ...translation, target: "zh-TW" }] })));
  assert.ok(bad.ok);
  assert.equal(bad.value.skipped.translations, 1);
});

test("错误带着三种说明：繁体不可枚举，可枚举的字段和以前一样", () => {
  const text = bothLangs((say) => say.baseUrlBad);
  assert.deepEqual(text, { message: providerText("zh").baseUrlBad, messageEn: providerText("en").baseUrlBad, messageHant: providerText("zh-Hant").baseUrlBad });
  assert.notEqual(text.messageHant, text.message);
  const error = withEnglish(Object.assign(new Error(text.message), { code: "INVALID_BASE_URL" }), text.messageEn, text.messageHant);
  assert.deepEqual(Object.keys(error), ["code"]);
  assert.equal(Object.getOwnPropertyDescriptor(error, "messageHant")?.enumerable, false);
  assert.equal(JSON.stringify({ ...error }), JSON.stringify({ code: "INVALID_BASE_URL" }));
  assert.equal(messageIn(error, "zh-Hant"), text.messageHant);
  assert.equal(messageIn(error, "en"), text.messageEn);
  assert.equal(messageIn(error, "zh"), text.message);
  const both = transportBoth((say) => say.canceled);
  assert.equal(both.messageHant, "任務已取消。");
});

test("按语言挑说明：挂着繁体的用繁体，没挂的照原话；繁体的回执用繁体那句", () => {
  const error = withEnglish(Object.assign(new Error("简体说明"), { code: "INVALID_BASE_URL" }), "English", "繁體說明");
  assert.equal(messageIn(error, "zh-Hant"), "繁體說明");
  assert.equal(messageIn({ message: "服务的原话" }, "zh-Hant"), "服务的原话");
  assert.equal(aiErrorResponse(error, "zh-Hant").message, "繁體說明");
  assert.equal(aiErrorResponse(error, "zh").message, "简体说明");
  assert.equal(messageIn({ message: "服务返回 502" }, "zh-Hant"), providerText("zh-Hant").statusOnly(502));
});

test("报错三段：繁体拼成一段时和简体一样直接连写", () => {
  const copy = errorCopy("NO_CAPTIONS", undefined, "zh-Hant");
  assert.notDeepEqual(copy, errorCopy("NO_CAPTIONS", undefined, "zh"));
  assert.equal(describe("NO_CAPTIONS", undefined, "zh-Hant"), [copy.cause, copy.impact, copy.next].join(""));
  assert.doesNotMatch(describe("NO_CAPTIONS", undefined, "zh-Hant"), /。 /);
});

test("界面文字接上了繁体：数据说明、档位名、分组名、字幕轨名字；模型输出相关的兜底回答还回落到简体", () => {
  const items = DATA_CONSENT_TABLE.flatMap((row) => row.items);
  const hant = noticeLines(items, "zh-Hant");
  assert.deepEqual(hant.map(({ kind, ids }) => ({ kind, ids })), noticeLines(items, "zh").map(({ kind, ids }) => ({ kind, ids })));
  assert.deepEqual(
    ["推荐看", "可以看", "可跳过", "信息不足", "看概览就够", "值得看完整视频", "模型自创"].map((label) => verdictName(label, "zh-Hant")),
    ["推薦看", "可以看", "可跳過", "資訊不足", "看概覽就夠", "推薦看", "模型自创"],
  );
  assert.equal(groupName("pending", "zh-Hant"), "還沒判斷");
  assert.equal(groupName("watch", "zh-Hant"), "推薦看");
  assert.equal(groupName("legacy", "zh-Hant"), "看概覽就夠");
  assert.equal(fallbackAnswer("zh-Hant"), FALLBACK_ANSWERS["zh-Hant"]);
  assert.equal(fallbackAnswer("zh"), FALLBACK_ANSWERS.zh);
  assert.equal(fallbackAnswer("en"), FALLBACK_ANSWERS.en);
  assert.equal(biliTrackName("zh-CN", "zh-Hant", "human"), "中文（中國）");
  assert.equal(biliTrackName("ai-en", "zh-Hant", "auto"), "英文（自動產生）");
  assert.equal(youtubeTrackName("panel:YouTube 文字稿", "zh-Hant"), "YouTube 轉錄稿");
  assert.equal(youtubeTrackName("panel:YouTube 文字稿（来源未确认）", "zh-Hant"), "YouTube 轉錄稿（來源未確認）");
  assert.equal(youtubeTrackName("panel:English", "zh-Hant"), null);
});

test("样板：设置校验提示的繁体那份已经接上，形状和简体一样", () => {
  assert.equal(settingsCheckText("zh-Hant"), CHECK_HANT);
  assert.deepEqual(Object.keys(CHECK_HANT).sort(), Object.keys(settingsCheckText("zh")).sort());
  assert.notEqual(settingsCheckText("zh-Hant").missingKey, settingsCheckText("zh").missingKey);
});

test("<html lang>：繁体写 zh-Hant", () => {
  assert.deepEqual(HTML_LANG, { zh: "zh-CN", "zh-Hant": "zh-Hant", en: "en" });
});
