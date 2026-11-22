// 模型写繁体时各服务的走法：翻译按繁体那一节发、和简体译文分开存；问答的兜底回答、解释的截断提示是繁体，跟着回答存下。
// 简体和英文的翻译请求和加繁体那一节之前逐字相同。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { FALLBACK_ANSWERS } from "../../../../src/background/services/qa.ts";
import { textFingerprint } from "../../../../src/core/transcript/fingerprint.ts";
import { studyHarness, VIDEO as STUDY_VIDEO } from "../../../helpers/study-service.ts";
import { batchOf, cue, page, transcriptView, translateHarness } from "../../../helpers/translate-service.ts";

const BEFORE = JSON.parse(readFileSync(new URL("../../../fixtures/golden/prompts-zh-en.json", import.meta.url), "utf8")) as Record<"zh" | "en", Record<string, Record<string, string>>>;

const ENGLISH = [cue(0, "This is a fairly long English sentence about growing tomatoes."), cue(10, "Water them early in the morning before it gets too hot outside.")];
const CHINESE = [cue(0, "这是一段讲种番茄的字幕，内容比较长"), cue(10, "早上天还没热的时候先浇水，效果最好")];

/** 译成繁体：每段换成一句繁体。 */
const hant = (request: Parameters<typeof batchOf>[0]): string =>
  JSON.stringify({ segments: batchOf(request).map(({ id }) => ({ id, text: `這是第 ${id} 段的繁體譯文。` })) });

const systemOf = (h: ReturnType<typeof translateHarness>, index = 0): string => String(h.fake.calls[index]?.request.messages?.find((message) => message.role === "system")?.content ?? "");

test("选繁体、字幕是英文：译成繁体，请求带繁体那一节；译文记在繁体名下，不占简体那一份", async () => {
  const view = await transcriptView(ENGLISH, "en");
  const h = translateHarness(view, { outputLang: "zh-Hant", reply: hant });
  const listener = page("panel-1");
  await h.translate(listener);
  assert.equal(h.requests(), 1);
  const system = systemOf(h);
  assert.match(system, /^你在给视频字幕做翻译，译成繁体中文。/);
  assert.match(system, /用繁体中文写，用词按台湾的习惯/);
  assert.ok(!system.includes("「用 Python 写」"), "没带简体那一节");
  assert.deepEqual(listener.translated(), { s0: "這是第 s0 段的繁體譯文。", s1: "這是第 s1 段的繁體譯文。" });
  const stored = await h.store.find(view.transcript.ref, "zh-Hant");
  assert.equal(Object.keys(stored?.segments ?? {}).length, 2);
  assert.equal(stored?.derived.gen?.outputLang, "zh-Hant");
  assert.equal(await h.store.find(view.transcript.ref, "zh"), null);
});

test("选繁体、字幕是中文：译成英文，请求和选简体时逐字相同", async () => {
  const view = await transcriptView(CHINESE, "zh-CN");
  const h = translateHarness(view, { outputLang: "zh-Hant", reply: (request) => JSON.stringify({ segments: batchOf(request).map(({ id }) => ({ id, text: `English ${id}` })) }) });
  await h.translate(page("panel-1"));
  assert.equal(systemOf(h), BEFORE.en["study/translation.md"]?.["系统提示词"]);
  assert.ok(await h.store.find(view.transcript.ref, "en"));
});

test("简体和英文的翻译请求：系统提示词和加繁体那一节之前逐字相同", async () => {
  const toZh = translateHarness(await transcriptView(ENGLISH, "en"), { outputLang: "zh" });
  await toZh.translate(page("panel-1"));
  assert.equal(systemOf(toZh), BEFORE.zh["study/translation.md"]?.["系统提示词"]);

  const toEn = translateHarness(await transcriptView(CHINESE, "zh-CN"), { reply: (request) => JSON.stringify({ segments: batchOf(request).map(({ id }) => ({ id, text: `English ${id}` })) }) });
  await toEn.translate(page("panel-1"));
  assert.equal(systemOf(toEn), BEFORE.en["study/translation.md"]?.["系统提示词"]);
});

test("同一版字幕已有简体译文：选繁体照样请求模型，简体那一份不动；再译繁体直接用存下的", async () => {
  const view = await transcriptView(ENGLISH, "en");
  const h = translateHarness(view, { outputLang: "zh-Hant", reply: hant });
  const simplified: Record<string, string> = {};
  for (const item of ENGLISH) simplified[await textFingerprint(item.text)] = `简体:${item.text}`;
  const gen = { feature: "rewrite", promptVersion: "v1", model: "m", effort: "off" as const };
  await h.store.merge({ transcript: view.transcript.ref, target: "zh", segments: simplified, derived: { basis: { source: "transcript", transcript: view.transcript.ref }, gen } });

  const first = page("panel-1");
  await h.translate(first);
  assert.equal(h.requests(), 1, "简体的译文不拿来当繁体");
  assert.ok(Object.values(first.translated()).every((text) => text.includes("繁體")));
  assert.deepEqual((await h.store.find(view.transcript.ref, "zh"))?.segments, simplified);

  const again = page("panel-2");
  await h.translate(again);
  assert.equal(h.requests(), 1, "繁体的已经存下，不再请求");
  assert.deepEqual(again.translated(), first.translated());
});

test("问答在繁体下一个有效出处都没有：整条换成繁体的兜底回答存下", async () => {
  const h = studyHarness({ outputLang: "zh-Hant", ai: { replies: { qa: JSON.stringify({ answer: "編造的結論。【0:00|字幕句子這幾個字不在字幕裡】" }) } } });
  const result = await h.ask("講了什麼？").result;
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.entry.answer, FALLBACK_ANSWERS["zh-Hant"]);
  assert.deepEqual(result.value.entry.citations, []);
  const [saved] = await h.qaStore.byVideo(STUDY_VIDEO);
  assert.equal(saved?.answer, FALLBACK_ANSWERS["zh-Hant"]);
  assert.equal(saved?.derived.gen?.outputLang, "zh-Hant");
});

test("问答在繁体下照抄简体字幕作出处：回答照收，引用的是字幕原文", async () => {
  const h = studyHarness({ outputLang: "zh-Hant", ai: { replies: { qa: JSON.stringify({ answer: "講的是字幕句子。【0:00|字幕句子】" }) } } });
  const result = await h.ask("講了什麼？").result;
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.entry.answer, "講的是字幕句子。[0:00]");
  assert.deepEqual(result.value.entry.citations, [{ startSeconds: 0, quote: "字幕句子" }]);
});

test("划词解释在繁体下被截断：末尾接繁体的提示；简体照旧", async () => {
  const reply = { text: "這個術語指的是", truncated: true as const };
  const traditional = studyHarness({ outputLang: "zh-Hant", ai: { replies: { explain: reply } } });
  const hantResult = await traditional.explain.explain(await traditional.register("explain", { selection: "術語", context: "" }), STUDY_VIDEO);
  assert.ok(hantResult.ok, JSON.stringify(hantResult));
  assert.equal(hantResult.value.explanation, "這個術語指的是…（模型輸出被截斷，回答可能不完整。）");

  const simplified = studyHarness({ ai: { replies: { explain: reply } } });
  const zhResult = await simplified.explain.explain(await simplified.register("explain", { selection: "术语", context: "" }), STUDY_VIDEO);
  assert.ok(zhResult.ok, JSON.stringify(zhResult));
  assert.equal(zhResult.value.explanation, "這個術語指的是…（模型输出被截断，回答可能不完整。）");
});
