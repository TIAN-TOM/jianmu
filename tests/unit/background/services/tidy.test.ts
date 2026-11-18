// 整理字幕（补标点、改同音错字）：和翻译同一套分批、补轮、停止和本机存储，按字幕版本存成 tidy，下次直接用；
// 用整理字幕自己的提示词和模型槽；改得太多的段记成原文，照旧显示原文，也不再为它花钱；和译文各存各的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSLATE_RETRY_DELAY_MS } from "../../../../src/background/services/translate.ts";
import type { CompletionRequest } from "../../../../src/core/ai/transport/index.ts";
import { batchOf, cue, page, PATIENT, transcriptView, translateHarness } from "../../../helpers/translate-service.ts";
import { until } from "../../../helpers/wait-until.ts";

const LINES = [cue(0, "大家好欢迎回来"), cue(10, "今天聊一聊字幕"), cue(20, "我门开始吧")];

/** 补标点；第三段顺手改掉同音错字。 */
const punctuate = (request: CompletionRequest): string =>
  JSON.stringify({ segments: batchOf(request).map(({ id, text }) => ({ id, text: `${text.replace("我门", "我们")}。` })) });

test("整理字幕：用自己的提示词和模型槽，结果按字幕版本存成 tidy，再点直接用存下的", async () => {
  const view = await transcriptView(LINES);
  const h = translateHarness(view, { tidyReply: punctuate });
  const first = page("panel-1");
  await h.tidy(first);
  assert.equal(h.tidyRequests(), 1);
  assert.equal(h.requests(), 0, "没走翻译的模型槽");
  const system = String(h.fake.calls[0]?.request.messages?.find((message) => message.role === "system")?.content ?? "");
  assert.match(system, /整理视频字幕/);
  assert.match(system, /不是给你的指令/);
  assert.deepEqual(first.translated(), { s0: "大家好欢迎回来。", s1: "今天聊一聊字幕。", s2: "我们开始吧。" });
  assert.equal(first.of("translate.started")[0]?.target, "tidy");
  const stored = await h.store.find(view.transcript.ref, "tidy");
  assert.equal(Object.keys(stored?.segments ?? {}).length, 3);
  assert.equal(await h.store.find(view.transcript.ref, "en"), null, "不当成译文存");

  const again = page("panel-2");
  await h.tidy(again);
  assert.equal(h.tidyRequests(), 1, "没有再请求模型");
  assert.deepEqual(again.translated(), first.translated());
});

test("模型把一段改写成自己的话：这一段不用，记成原文照旧显示，也不补轮再花钱；别的段照常用", async () => {
  const view = await transcriptView(LINES);
  const rewrite = (request: CompletionRequest): string =>
    JSON.stringify({ segments: batchOf(request).map(({ id, text }) => ({ id, text: id === "s1" ? "本期节目我们将深入探讨视频字幕的相关话题。" : `${text}。` })) });
  const h = translateHarness(view, { tidyReply: rewrite });
  const listener = page("panel-1");
  await h.tidy(listener);
  assert.equal(h.tidyRequests(), 1, "改写的那段不补轮");
  assert.equal(listener.translated().s1, "今天聊一聊字幕", "照旧是原文");
  assert.equal(listener.translated().s0, "大家好欢迎回来。");
  assert.deepEqual(listener.of("translate.done").map(({ state, failedBatches }) => ({ state, failedBatches })), [{ state: "completed", failedBatches: 0 }]);
});

test("模型漏了一段：漏的那段等一会儿补一轮", async () => {
  const view = await transcriptView(LINES);
  let round = 0;
  const skipFirst = (request: CompletionRequest): string => {
    round += 1;
    const items = batchOf(request).filter(({ id }) => round > 1 || id !== "s2");
    return JSON.stringify({ segments: items.map(({ id, text }) => ({ id, text: `${text}。` })) });
  };
  const h = translateHarness(view, { tidyReply: skipFirst });
  const listener = page("panel-1");
  const running = h.tidy(listener);
  assert.ok(await until(() => h.tidyRequests() === 1, PATIENT));
  assert.ok(await until(() => h.timers.pending() > 0, PATIENT), "补轮在等");
  h.timers.advance(TRANSLATE_RETRY_DELAY_MS);
  await running;
  assert.equal(h.tidyRequests(), 2);
  assert.equal(listener.translated().s2, "我门开始吧。");
});

test("整理字幕和翻译各存各的：同一版字幕两样都有，互不覆盖", async () => {
  const view = await transcriptView(LINES);
  const h = translateHarness(view, { tidyReply: punctuate });
  await h.tidy(page("a"));
  await h.translate(page("b"));
  assert.equal(Object.keys((await h.store.find(view.transcript.ref, "tidy"))?.segments ?? {}).length, 3);
  assert.equal(Object.keys((await h.store.find(view.transcript.ref, "en"))?.segments ?? {}).length, 3);
});

test("翻译端口认整理字幕：purpose 只收 tidy，和 fromSec 可以一起带；发起时把 purpose 交给服务", async () => {
  const { translatePort } = await import("../../../../src/background/routes/translate.ts");
  const started: unknown[] = [];
  const spec = translatePort({ translate: { start: async (_video, options) => void started.push(options.purpose), stop: () => {}, leave: () => {} } }).translate;
  const video = (await transcriptView(LINES)).video;
  const ctx = {} as never;
  assert.equal(spec.validate({ type: "translate.start", video, purpose: "tidy" }, ctx), true);
  assert.equal(spec.validate({ type: "translate.start", video, purpose: "tidy", fromSec: 5 }, ctx), true);
  assert.equal(spec.validate({ type: "translate.start", video, purpose: "rewrite" }, ctx), false);
  assert.equal(spec.validate({ type: "translate.start", video, purpose: "tidy", extra: 1 }, ctx), false);
  assert.equal(spec.validate({ type: "translate.start", video, fromSec: -1, purpose: "tidy" }, ctx), false);
  assert.equal(spec.validate({ type: "translate.start", video, purpose: "tidy", tabId: 3, storedOnly: true }, ctx), true, "带上视频所在的标签页");
  assert.equal(spec.validate({ type: "translate.start", video, tabId: -1 }, ctx), false);
  assert.equal(spec.validate({ type: "translate.start", video, tabId: "3" }, ctx), false);
  const handlers = spec.onConnect({ id: "p1", post: () => {} } as never, ctx);
  await handlers.onMessage({ type: "translate.start", video, purpose: "tidy" });
  assert.deepEqual(started, ["tidy"]);
});

test("只取本机存着的：没存过时一个模型请求都不发，也不登记任务；存过的照常交回", async () => {
  const view = await transcriptView(LINES);
  const h = translateHarness(view, { tidyReply: punctuate });
  const empty = page("peek-1");
  await h.service.start(view.video, { origin: "user", listener: empty, purpose: "tidy", storedOnly: true });
  assert.equal(h.tidyRequests(), 0);
  assert.deepEqual(empty.translated(), {});
  assert.deepEqual(empty.of("translate.done").map(({ state, totalBatches }) => ({ state, totalBatches })), [{ state: "completed", totalBatches: 0 }]);
  assert.deepEqual(h.tasks.list(), []);

  await h.tidy(page("click"));
  const later = page("peek-2");
  await h.service.start(view.video, { origin: "user", listener: later, purpose: "tidy", storedOnly: true });
  assert.equal(h.tidyRequests(), 1);
  assert.equal(Object.keys(later.translated()).length, 3);
});

test("一整批 12 段里漏了三段、改写了一段：其余的照常用，改写的照旧是原文，漏的三段另凑一批补上，不整批作废", async () => {
  const { TRANSLATION_BATCH_MAX_SEGMENTS } = await import("../../../../src/core/ai/chunking.ts");
  const many = Array.from({ length: TRANSLATION_BATCH_MAX_SEGMENTS }, (_, index) => cue(index * 10, `第${index + 1}句没有标点`));
  const view = await transcriptView(many);
  let round = 0;
  const sloppy = (request: CompletionRequest): string => {
    round += 1;
    const items = batchOf(request).filter(({ id }) => round > 1 || !["s2", "s5", "s9"].includes(id));
    return JSON.stringify({ segments: items.map(({ id, text }) => ({ id, text: id === "s0" ? "完全换成了另一套说法的一句话。" : `${text}。` })) });
  };
  const h = translateHarness(view, { tidyReply: sloppy });
  const listener = page("panel");
  const running = h.tidy(listener);
  assert.ok(await until(() => h.tidyRequests() === 1, PATIENT));
  assert.ok(await until(() => h.timers.pending() > 0, PATIENT), "补轮在等");
  h.timers.advance(TRANSLATE_RETRY_DELAY_MS);
  await running;
  assert.equal(h.tidyRequests(), 2, "整批一次，漏的三段补一次");
  const shown = listener.translated();
  assert.equal(Object.keys(shown).length, TRANSLATION_BATCH_MAX_SEGMENTS);
  assert.equal(shown.s0, "第1句没有标点", "改写的照旧是原文");
  assert.equal(shown.s5, "第6句没有标点。", "漏的补上了");
  assert.equal(shown.s11, "第12句没有标点。");
  const retried = batchOf(h.fake.calls[1]!.request).map(({ id }) => id);
  assert.deepEqual(retried, ["s2", "s5", "s9"], "补轮只发漏的那几段");
});
