// 翻译：后台分批请求模型，每批推给页面并按字幕版本存下；原文没变的段换了版本也不再付费。
// 跟着页面走：订阅的面板都关了才停下还没开始的批次，在途的照常存下；点停止连在途的一起中止。
// 服务的测试用架子（任务、仓储、闸门是真的，字幕和模型是替身，或换成真实的取字幕服务）；
// 要看真实传输层和端口的几条走真实的后台分发。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { createPorts } from "../../../../src/background/routes/index.ts";
import { TRANSLATE_RETRY_DELAY_MS } from "../../../../src/background/services/translate.ts";
import { PROTOCOLS } from "../../../../src/core/ai/provider/index.ts";
import { describe } from "../../../../src/core/errors.ts";
import type { FrozenGen } from "../../../../src/core/tasks.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import type { TranslateOut } from "../../../../src/shared/messages/translate.ts";
import type { Cue } from "../../../../src/sites/types.ts";
import { createFakeChrome, senders, STALE_CONFIRMATION, type FakePort } from "../../../helpers/chrome.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { chatReply, keyedStorage, modelService, reply, type SentRequest } from "../../../helpers/fake-model-service.ts";
import { fakeSiteService, sampleInfo } from "../../../helpers/fake-site-service.ts";
import * as RESP from "../../../helpers/responses-fixtures.ts";
import { cachedRow, harness, REF, ZH } from "../../../helpers/transcript-service.ts";
import { batchOf, cue, echo, page, PATIENT, transcriptView, translateHarness, TRANSLATION_PROMPT, VIDEO } from "../../../helpers/translate-service.ts";
import { until } from "../../../helpers/wait-until.ts";
import { ROUTE_MATRIX } from "../route-matrix.ts";

/** 5 段：分成两批（4 段和 1 段）。 */
const FIVE = [cue(0, "第一句"), cue(10, "第二句"), cue(20, "第三句"), cue(30, "第四句"), cue(40, "第五句")];
/** 9 段：三批。 */
const NINE = Array.from({ length: 9 }, (_, index) => cue(index * 10, `第${index + 1}段`));

const SRT = ["1", "00:00:00,000 --> 00:00:02,000", "导入的第一句", "", "2", "00:00:02,000 --> 00:00:04,000", "导入的第二句", ""].join("\n");

const genOf = (feature: string): FrozenGen => ({ feature, baseUrl: "https://ai.example.test/v1", model: `${feature}-model`, effort: "off", promptVersion: "v1" });

const done = (target: ReturnType<typeof page>) => target.of("translate.done");

const eventually = (check: () => boolean | Promise<boolean>): Promise<boolean> => until(check, PATIENT);

// ============================================================
// 存下、直接交回、换字幕版本
// ============================================================

test("翻译时字幕没换：照常存下译文，再翻译同一版直接用存下的，不再请求模型", async () => {
  const view = await transcriptView(FIVE);
  const h = translateHarness(view);
  const first = page("panel-1");
  await h.translate(first);
  assert.equal(h.requests(), 2, "两批");
  const all = { s0: "译:第一句", s1: "译:第二句", s2: "译:第三句", s3: "译:第四句", s4: "译:第五句" };
  assert.deepEqual(first.translated(), all);
  assert.deepEqual(done(first).map(({ state, totalBatches, failedBatches }) => ({ state, totalBatches, failedBatches })), [
    { state: "completed", totalBatches: 2, failedBatches: 0 },
  ]);
  const stored = await h.store.find(view.transcript.ref, "en");
  assert.equal(Object.keys(stored?.segments ?? {}).length, 5);
  assert.equal(stored?.derived.basis.source, "transcript");

  const again = page("panel-2");
  await h.translate(again);
  assert.equal(h.requests(), 2, "没有再请求模型");
  assert.deepEqual(again.translated(), all);
  assert.deepEqual(again.of("translate.segments").map((event) => event.stored), [true]);
  assert.equal(again.of("translate.started").length, 0, "没有要请求模型的段，不登记任务");
  assert.deepEqual(done(again), [{ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 }]);
  assert.deepEqual(h.tasks.list(), []);
});

test("翻译在途时换了字幕语言：结果照常推给页面，但只记在原来那一版字幕名下", async () => {
  const zh = await transcriptView(FIVE.slice(0, 2));
  const en = await transcriptView([cue(0, "First line"), cue(10, "Second line")], "en-US");
  const h = translateHarness(zh);
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  // 模型还在生成时，侧边栏切到英文字幕。两版的分段编号一样，撞号是这个问题的前提。
  h.show(en);
  release();
  await running;
  assert.deepEqual(panel.translated(zh.transcript.ref.fingerprint), { s0: "译:第一句", s1: "译:第二句" });
  assert.ok(await h.store.find(zh.transcript.ref, "en"), "记在中文那一版名下");
  assert.equal(await h.store.find(en.transcript.ref, "zh"), null, "英文这一版没有被标成已翻译");
  assert.equal(await h.store.find(en.transcript.ref, "en"), null);

  const next = page("panel-2");
  await h.translate(next);
  assert.equal(h.requests(), 2, "英文这一版翻译时照常请求模型");
  assert.equal(next.of("translate.started")[0]?.target, "zh", "外文字幕译成中文");
  assert.deepEqual(next.of("translate.segments").filter((event) => event.stored), []);
});

test("译文存不下：照常推给页面，并说明没能保存", async () => {
  const view = await transcriptView(FIVE);
  const h = translateHarness(view, {
    wrapDriver: (inner) => ({
      ...inner,
      write: async () => {
        throw new Error("磁盘满了");
      },
    }),
  });
  const panel = page("panel");
  await h.translate(panel);
  assert.equal(Object.keys(panel.translated()).length, 5, "付过费的译文照样给页面");
  assert.ok(panel.of("translate.segments").every((event) => event.saveFailed === true));
  assert.equal(done(panel)[0]?.state, "completed");
  assert.equal(done(panel)[0]?.saveFailed, true);
  assert.deepEqual(await h.store.byVideo(VIDEO), []);
});

test("翻译批次模型没按 JSON 回：给中文说明和错误码，不显示 V8 的 SyntaxError", async () => {
  const view = await transcriptView(FIVE);
  const h = translateHarness(view, { reply: "{segments: [oops" });
  const panel = page("panel");
  await h.translate(panel);
  assert.equal(h.requests(), 2, "两批都失败，全军覆没不补");
  assert.equal(h.timers.due(TRANSLATE_RETRY_DELAY_MS), 0);
  const [end] = done(panel);
  assert.equal(end?.state, "failed");
  assert.deepEqual(end?.failure, { code: "TRANSLATE_PARSE_FAILED" }, "不带解析器的报错");
  const text = describe("TRANSLATE_PARSE_FAILED");
  assert.doesNotMatch(text, /JSON|SyntaxError|Unexpected|position/);
  assert.match(text, /按功能选模型/);
  assert.deepEqual(await h.store.byVideo(VIDEO), []);
});

test("翻译请求在途时清除了全部本机数据：回来的译文不写回刚清空的译文存储", async () => {
  const view = await transcriptView(FIVE);
  const h = translateHarness(view);
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(2));
  await h.guard.clear("all", () => h.driver.clear());
  release();
  await running;
  assert.deepEqual(await h.driver.getAll(), [], "清除之后不写回");
  assert.equal(Object.keys(panel.translated()).length, 5, "付过费的照样推给页面");
});

test("只清除缓存时译文不在清除范围里：在途回来的照常存下", async () => {
  const view = await transcriptView(FIVE);
  const h = translateHarness(view);
  const release = h.fake.hold("rewrite");
  const running = h.translate(page("panel"));
  assert.ok(await h.requested(2));
  await h.guard.clear("cache", async () => {});
  release();
  await running;
  assert.equal(Object.keys((await h.store.find(view.transcript.ref, "en"))?.segments ?? {}).length, 5);
});

test("同一版字幕的几批译文同时落库：读—改—写排队，后写的不冲掉先写的", async () => {
  const view = await transcriptView(NINE);
  const h = translateHarness(view, {
    // 读得慢一点，几批的读—改—写不排队就会交错，后写的拿旧记录冲掉先写的。
    wrapDriver: (inner) => ({
      ...inner,
      async get(key) {
        await nextTurn();
        return inner.get(key);
      },
    }),
  });
  const release = h.fake.hold("rewrite");
  const running = h.translate(page("panel"));
  assert.ok(await h.requested(3), "三批同时在途");
  release();
  await running;
  assert.equal(Object.keys((await h.store.find(view.transcript.ref, "en"))?.segments ?? {}).length, 9);
});

test("从播放到的位置往后的先译，前面的随后补齐", async () => {
  const h = translateHarness(await transcriptView(FIVE), { concurrency: 1 });
  await h.translate(page("panel"), { fromSec: 25 });
  assert.deepEqual(
    h.fake.calls.map(({ request }) => batchOf(request).map(({ id }) => id)),
    [["s3", "s4", "s0", "s1"], ["s2"]],
  );
});

test("偶发失败的批次等一会儿静默补一轮，补轮那一批传输层不再自己重发；全军覆没不补", async () => {
  const view = await transcriptView(FIVE);
  let flaky = true;
  const h = translateHarness(view, {
    reply(request) {
      if (flaky && batchOf(request).some(({ id }) => id === "s4")) {
        flaky = false;
        throw Object.assign(new Error("服务过载"), { status: 503 });
      }
      return echo()(request);
    },
  });
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await eventually(() => h.timers.due(TRANSLATE_RETRY_DELAY_MS) === 1), "等一会儿再补");
  assert.equal(h.requests(), 2);
  h.timers.fire(TRANSLATE_RETRY_DELAY_MS);
  await running;
  assert.equal(h.requests(), 3);
  assert.deepEqual(h.fake.calls.map(({ request }) => request.selfRetry), [true, true, false]);
  assert.deepEqual(done(panel).map(({ state, failedBatches }) => ({ state, failedBatches })), [{ state: "completed", failedBatches: 0 }]);
  assert.equal(Object.keys(panel.translated()).length, 5);

  const broken = translateHarness(view, { reply: Object.assign(new Error("服务过载"), { status: 503 }) });
  const other = page("panel-2");
  await broken.translate(other);
  assert.equal(broken.requests(), 2, "两批都失败：多半是配置或服务的问题，不补");
  assert.equal(broken.timers.due(TRANSLATE_RETRY_DELAY_MS), 0);
  assert.equal(done(other)[0]?.state, "failed");
});

test("模型回的一条都对不上（编号改了、原文抄回来）：这一批算没译成，等一会儿补一轮，不推空结果", async () => {
  const view = await transcriptView(FIVE);
  let garbled = true;
  const h = translateHarness(view, {
    reply(request) {
      const batch = batchOf(request);
      if (garbled && batch.some(({ id }) => id === "s4")) {
        garbled = false;
        return JSON.stringify({ segments: batch.map(({ id, text }) => ({ id: `${id}-x`, text })) });
      }
      return echo()(request);
    },
  });
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await eventually(() => h.timers.due(TRANSLATE_RETRY_DELAY_MS) === 1), "这一批算失败，等着补");
  assert.ok(panel.of("translate.segments").every((event) => Object.keys(event.translated).length > 0), "不推空的结果");
  h.timers.fire(TRANSLATE_RETRY_DELAY_MS);
  await running;
  assert.equal(h.requests(), 3);
  assert.equal(panel.translated().s4, "译:第五句");
});

// ============================================================
// 跟着页面走：关面板、停止、接上、互斥
// ============================================================

test("侧边栏翻译途中关掉：还没开始的批次不再发，任务收尾，重开面板能再翻译", async () => {
  const view = await transcriptView(NINE);
  const h = translateHarness(view, { concurrency: 1 });
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  h.service.leave(panel.id);
  release();
  await running;
  assert.equal(h.requests(), 1, "后两批没发");
  assert.deepEqual(h.tasks.list(), [], "任务收了尾，不占着这个视频");

  const reopened = page("panel-again");
  await h.translate(reopened);
  assert.equal(done(reopened)[0]?.state, "completed");
  assert.equal(h.requests(), 3, "重开的面板只译剩下的两批");
  assert.equal(Object.keys(reopened.translated()).length, 9);
});

test("发起翻译后一批都还没发面板就关了：一批也不发，任务马上收尾", async () => {
  const view = await transcriptView(FIVE);
  const reading = deferred();
  const h = translateHarness(view, {
    transcript: {
      async ensure() {
        await reading.promise;
        return { ok: true, value: { view, generation: 0 } };
      },
      generation: () => 0,
    },
  });
  const panel = page("panel");
  const running = h.translate(panel);
  // 还在读字幕，面板就关了。
  h.service.leave(panel.id);
  reading.resolve();
  await running;
  assert.equal(h.requests(), 0);
  assert.deepEqual(h.tasks.list(), []);
  assert.deepEqual(panel.events, [], "关掉的面板不再收消息");
});

test("还在准备（读字幕、读本机译文）时点了停止：不登记任务，一个模型请求都不发", async () => {
  const view = await transcriptView(FIVE);
  const reading = deferred();
  const h = translateHarness(view, {
    transcript: {
      async ensure() {
        await reading.promise;
        return { ok: true, value: { view, generation: 0 } };
      },
      generation: () => 0,
    },
  });
  const panel = page("panel");
  const running = h.translate(panel);
  h.service.stop(panel.id);
  reading.resolve();
  await running;
  assert.equal(h.requests(), 0);
  assert.deepEqual(h.tasks.list(), []);
  assert.deepEqual(done(panel).map((event) => event.state), ["canceled"]);

  // 停止只管那一次：同一个面板再点翻译照常开始。
  await h.translate(panel);
  assert.equal(h.requests(), 2);
  assert.equal(done(panel).at(-1)?.state, "completed");
});

test("模型漏了几段：译出来的照常存下，漏的那几段等一会儿补一轮；补不上的算这一批没译完", async () => {
  const view = await transcriptView(FIVE.slice(0, 4));
  let first = true;
  const h = translateHarness(view, {
    reply(request) {
      const batch = batchOf(request);
      // 第一次只回第一段，补轮回全。
      const answered = first ? batch.slice(0, 1) : batch;
      first = false;
      return JSON.stringify({ segments: answered.map(({ id, text }) => ({ id, text: `译:${text}` })) });
    },
  });
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await eventually(() => h.timers.due(TRANSLATE_RETRY_DELAY_MS) === 1), "漏的段等着补");
  assert.deepEqual(Object.keys(panel.translated()), ["s0"], "译出来的先推给页面");
  h.timers.fire(TRANSLATE_RETRY_DELAY_MS);
  await running;
  assert.deepEqual(batchOf(h.fake.calls[1]?.request ?? { messages: [], maxTokens: 0 }).map(({ id }) => id), ["s1", "s2", "s3"], "补轮只发漏的那几段");
  assert.equal(Object.keys(panel.translated()).length, 4);
  assert.deepEqual(done(panel).map(({ state, failedBatches }) => ({ state, failedBatches })), [{ state: "completed", failedBatches: 0 }]);
  assert.equal(Object.keys((await h.store.find(view.transcript.ref, "en"))?.segments ?? {}).length, 4);

  const stubborn = translateHarness(view, {
    reply: (request) => JSON.stringify({ segments: batchOf(request).slice(0, 1).map(({ id, text }) => ({ id, text: `译:${text}` })) }),
  });
  const other = page("panel-2");
  const again = stubborn.translate(other);
  assert.ok(await eventually(() => stubborn.timers.due(TRANSLATE_RETRY_DELAY_MS) === 1));
  stubborn.timers.fire(TRANSLATE_RETRY_DELAY_MS);
  await again;
  assert.deepEqual(done(other).map(({ state, failedBatches }) => ({ state, failedBatches })), [{ state: "completed", failedBatches: 1 }], "补不上的不说成全译完了");
});

test("这一版已经译了一部分：缺的段先从同一视频的别的版本里找，找得到就不再请求模型", async () => {
  const five = await transcriptView(FIVE);
  const six = await transcriptView([...FIVE, cue(50, "第六句")]);
  const h = translateHarness(five, { concurrency: 1 });
  // 这一版译了四段就关了面板。
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const partial = h.translate(panel);
  assert.ok(await h.requested(1));
  h.service.leave(panel.id);
  release();
  await partial;
  assert.equal(Object.keys((await h.store.find(five.transcript.ref, "en"))?.segments ?? {}).length, 4);
  // 另一版（多一句）全译完了。
  h.show(six);
  await h.translate(page("panel-2"));
  const asked = h.requests();

  h.show(five);
  const back = page("panel-3");
  await h.translate(back);
  assert.equal(h.requests(), asked, "第五句在另一版里有，不再请求模型");
  assert.equal(Object.keys(back.translated()).length, 5);
  assert.equal(Object.keys((await h.store.find(five.transcript.ref, "en"))?.segments ?? {}).length, 5, "补上的也存进这一版");
});

test("停止只停点停止时已经在准备的那次：还没准备完又点了翻译，新点的照常开始", async () => {
  const view = await transcriptView(FIVE);
  const firstRead = deferred();
  let reads = 0;
  const h = translateHarness(view, {
    transcript: {
      async ensure() {
        reads += 1;
        if (reads === 1) await firstRead.promise;
        return { ok: true, value: { view, generation: 0 } };
      },
      generation: () => 0,
    },
  });
  const panel = page("panel");
  const stopped = h.translate(panel);
  h.service.stop(panel.id);
  await h.translate(panel);
  assert.equal(done(panel).at(-1)?.state, "completed", "停止之后新点的照常跑完");
  assert.equal(h.requests(), 2);
  firstRead.resolve();
  await stopped;
  assert.equal(h.requests(), 2, "被停的那次一个请求都没发");
  assert.equal(done(panel).length, 2);
  assert.equal(done(panel)[1]?.totalBatches, 0);
});

test("从旧版带过来的译文存不下：照样直接用，不为它们再请求模型", async () => {
  const older = await transcriptView(FIVE);
  const seeded = translateHarness(older);
  await seeded.translate(page("seed"));
  const seed = await seeded.driver.getAll();
  assert.equal(seed.length, 1);

  const newer = await transcriptView([...FIVE, cue(50, "第六句")]);
  const h = translateHarness(newer, {
    seed,
    wrapDriver: (inner) => ({
      ...inner,
      write: async () => {
        throw Object.assign(new Error("写满了"), { name: "QuotaExceededError" });
      },
    }),
  });
  const panel = page("panel");
  await h.translate(panel);
  assert.equal(Object.keys(panel.of("translate.segments").find((event) => event.stored)?.translated ?? {}).length, 5, "没变的五段直接交回");
  assert.equal(h.requests(), 1, "只为新加的那一段请求模型");
  assert.deepEqual(batchOf(h.fake.calls[0]?.request ?? { messages: [], maxTokens: 0 }).map(({ text }) => text), ["第六句"]);
});

test("面板关掉时还有一批在途：这批照常回来并存下，之后的批次不再发", async () => {
  const view = await transcriptView(NINE);
  const h = translateHarness(view, { concurrency: 1 });
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  h.service.leave(panel.id);
  release();
  await running;
  assert.equal(h.requests(), 1, "下一批没发");
  assert.equal(h.fake.calls[0]?.request.signal?.aborted, false, "在途的请求没被中止");
  const stored = await h.store.find(view.transcript.ref, "en");
  assert.equal(Object.keys(stored?.segments ?? {}).length, 4, "在途那批付过费，存下了");
});

test("点停止：在途的请求一起中止，不存也不再发", async () => {
  const view = await transcriptView(NINE);
  const h = translateHarness(view, { concurrency: 1 });
  h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  h.service.stop(panel.id);
  await running;
  assert.equal(h.requests(), 1);
  assert.equal(h.fake.calls[0]?.request.signal?.aborted, true, "在途的请求中止了");
  assert.deepEqual(await h.store.byVideo(VIDEO), []);
  assert.equal(done(panel)[0]?.state, "canceled");
  assert.deepEqual(h.tasks.list(), []);
});

test("一轮翻译跑完自己收尾；之后关掉那个面板，不会停掉别的面板发起的翻译", async () => {
  const h = translateHarness(await transcriptView(FIVE));
  const first = page("panel-1");
  await h.translate(first);
  assert.deepEqual(h.tasks.list(), []);

  h.show(await transcriptView([cue(0, "另一版第一句"), cue(10, "另一版第二句")]));
  const release = h.fake.hold("rewrite");
  const second = page("panel-2");
  const running = h.translate(second);
  assert.ok(await h.requested(3));
  h.service.leave(first.id);
  assert.deepEqual(h.tasks.list().map((task) => task.state), ["running"], "关掉的是跑完那一轮的面板，别的翻译照常跑");
  release();
  await running;
  assert.equal(done(second)[0]?.state, "completed");
});

test("概览、问答这些不跟着页面走的任务，翻译面板关掉也照常跑", async () => {
  const h = translateHarness(await transcriptView(FIVE));
  for (const kind of ["overview", "qa"] as const) {
    await h.tasks.register({ kind, origin: "user", video: VIDEO, input: kind === "qa" ? { question: "问题" } : undefined, gen: genOf(kind), followsPage: false }, {});
  }
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  h.service.leave(panel.id);
  assert.deepEqual(
    h.tasks.list().map((task) => [task.kind, task.state]),
    [
      ["overview", "running"],
      ["qa", "running"],
      ["translate", "canceled"],
    ],
  );
  release();
  await running;
  assert.deepEqual(h.tasks.list().map((task) => task.kind), ["overview", "qa"]);
});

test("两个面板翻译同一版字幕：后来的接上在跑的那一份，只请求一次模型，两边都收到译文", async () => {
  const h = translateHarness(await transcriptView(FIVE), { concurrency: 1 });
  const release = h.fake.hold("rewrite");
  const first = page("panel-1");
  const second = page("panel-2");
  const running = h.translate(first);
  assert.ok(await h.requested(1));
  await h.translate(second);
  assert.equal(second.of("translate.started")[0]?.joined, true);
  assert.equal(second.of("translate.started")[0]?.task.id, first.of("translate.started")[0]?.task.id);
  // 先开的那个面板关了，后来接上的还在：照常跑完。
  h.service.leave(first.id);
  release();
  await running;
  assert.equal(h.requests(), 2, "两批各请求一次");
  assert.equal(Object.keys(second.translated()).length, 5);
  assert.equal(done(second)[0]?.state, "completed");
});

test("同一个视频已有不一样的翻译在跑：回已有任务在跑，带着那个任务", async () => {
  const h = translateHarness(await transcriptView(FIVE));
  h.fake.hold("rewrite");
  const first = page("panel-1");
  void h.translate(first);
  assert.ok(await h.requested(1));
  // 同样译成英文，但字幕换了一版：不能接上，也不另起一份。
  h.show(await transcriptView([cue(0, "换过的第一句")]));
  const second = page("panel-2");
  await h.translate(second);
  const [refused] = second.of("translate.refused");
  assert.equal(refused?.failure.code, "TASK_ALREADY_RUNNING");
  assert.equal(refused?.task?.id, first.of("translate.started")[0]?.task.id);
  h.service.stop(first.id);
});

// ============================================================
// 和真实的取字幕服务一起：导入字幕、对不上的字幕、强制刷新
// ============================================================

/** 真实的取字幕服务会把相邻的字幕条并成一段，中文段落往往超过十个字：译文得是英文，才过得了「真译了」那道核对。 */
const english = (request: Parameters<ReturnType<typeof echo>>[0]): string =>
  JSON.stringify({ segments: batchOf(request).map(({ id, text }) => ({ id, text: `EN(${text.length}) ${id}` })) });

async function withTranscript(options: Parameters<typeof harness>[0] = {}) {
  const th = harness(options);
  const h = translateHarness(await transcriptView([]), { transcript: th.service, guard: th.guard, reply: english });
  return { th, h };
}

test("翻译批次等模型的工夫导入了字幕文件：旧字幕的译文不存，导入的字幕上没有它", async () => {
  const { th, h } = await withTranscript({ seed: [cachedRow(ZH)] });
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  assert.ok((await th.service.importFile(REF, { name: "课程.srt", text: SRT })).ok);
  release();
  await running;
  assert.equal(Object.keys(panel.translated()).length, 1, "付过费的照样推给页面");
  assert.deepEqual(await h.driver.getAll(), [], "旧字幕的译文没存");
  assert.equal(done(panel)[0]?.state, "canceled", "字幕换了，这一轮停下，让出这个视频");

  const next = page("panel-2");
  await h.translate(next);
  assert.equal(next.of("translate.started")[0]?.transcript.kind, "imported");
  assert.deepEqual(next.of("translate.segments").filter((event) => event.stored), [], "导入的字幕上没有旧字幕的译文");
});

test("导入字幕文件还没做完就开始翻译：等导入做完再读，译的是导入的字幕，旧字幕的译文不会出现", async () => {
  let hold: ReturnType<typeof deferred> | null = deferred();
  let held = 0;
  const { th, h } = await withTranscript({
    seed: [cachedRow(ZH)],
    wrapDriver: (inner) => ({
      ...inner,
      async write(change) {
        if (hold) {
          held += 1;
          await hold.promise;
        }
        return inner.write(change);
      },
    }),
  });
  const importing = th.service.importFile(REF, { name: "课程.srt", text: SRT });
  assert.ok(await eventually(() => held > 0), "作废旧字幕的那一下写入卡住了");
  const panel = page("panel");
  const running = h.translate(panel);
  await nextTurn();
  assert.equal(h.requests(), 0, "等导入做完才读字幕");
  const release = hold;
  hold = null;
  release.resolve();
  assert.ok((await importing).ok);
  await running;
  const started = panel.of("translate.started")[0];
  assert.equal(started?.transcript.kind, "imported", "读到的是导入的字幕");
  assert.equal(done(panel)[0]?.state, "completed");
  const records = await h.driver.getAll();
  assert.deepEqual(records.map((record) => record.transcript.kind), ["imported"], "译文记在导入的那一版名下，旧字幕没有译文");
  assert.ok(batchOf(h.fake.calls[0]?.request ?? { messages: [], maxTokens: 0 }).every(({ text }) => text.includes("导入的")));
});

test("翻译途中换过字幕文件：在途那批照常推给页面但不存，之后的批次不再发，任务让出来", async () => {
  const h = translateHarness(await transcriptView(NINE), { concurrency: 1 });
  const release = h.fake.hold("rewrite");
  const panel = page("panel");
  const running = h.translate(panel);
  assert.ok(await h.requested(1));
  h.bumpGeneration();
  release();
  await running;
  assert.equal(h.requests(), 1, "后两批没发");
  assert.equal(Object.keys(panel.translated()).length, 4);
  assert.deepEqual(await h.store.byVideo(VIDEO), []);
  assert.equal(done(panel)[0]?.state, "canceled");
  assert.deepEqual(h.tasks.list(), []);
});

test("导入字幕后旧字幕版本的译文不会被新版本读到", async () => {
  const { th, h } = await withTranscript({ seed: [cachedRow(ZH)] });
  await h.translate(page("panel"));
  assert.equal((await h.driver.getAll()).length, 1);
  assert.ok((await th.service.importFile(REF, { name: "课程.srt", text: SRT })).ok);
  const next = page("panel-2");
  await h.translate(next);
  assert.deepEqual(next.of("translate.segments").filter((event) => event.stored), []);
  assert.equal(next.of("translate.started")[0]?.transcript.kind, "imported");
  assert.equal(h.requests(), 2, "导入的字幕重新请求模型");
});

/** 时间轴跑到 900 秒，视频只有 120 秒：对不上，只记在内存里。 */
const OVERRUN: Cue[] = [
  { start: 0, duration: 2, text: "对不上的第一句" },
  { start: 898, duration: 2, text: "对不上的第二句" },
];
const FITS: Cue[] = [
  { start: 0, duration: 2, text: "对得上的第一句" },
  { start: 100, duration: 2, text: "对得上的第二句" },
];

test("对不上的字幕也照常翻译：译文按那一版字幕存下，不新建字幕缓存条目", async () => {
  const { th, h } = await withTranscript({ site: { captions: () => ({ ok: true, value: OVERRUN }) } });
  const panel = page("panel");
  await h.translate(panel);
  const pending = panel.of("translate.started")[0]?.pending ?? 0;
  assert.ok(pending > 0);
  assert.equal(done(panel)[0]?.state, "completed");
  const [record] = await h.driver.getAll();
  assert.equal(record?.transcript.fingerprint, panel.of("translate.started")[0]?.transcript.fingerprint);
  assert.equal(Object.keys(record?.segments ?? {}).length, pending);
  assert.deepEqual(await th.rows(), [], "字幕缓存里没有新条目");
});

test("只有内存里那份对不上的字幕：强制刷新拿回同样的字幕，已经翻过的译文留着", async () => {
  const { th, h } = await withTranscript({ site: { captions: () => ({ ok: true, value: OVERRUN }) } });
  const first = page("panel");
  await h.translate(first);
  const refreshed = await th.service.get(REF, { mode: "full", fresh: true });
  assert.ok(refreshed.ok && refreshed.value.subtitleMismatch);
  assert.equal(th.site.count("readCaptions"), 2, "强制刷新真的重新取了");
  const again = page("panel-2");
  await h.translate(again);
  assert.equal(h.requests(), 1, "下一轮翻译不再为它们计费");
  assert.deepEqual(again.translated(), first.translated());
  assert.deepEqual(await th.rows(), []);
});

test("缓存里有正常字幕、强制刷新拿到对不上的：以缓存为准，翻译用的也是缓存那一版，译文都还在", async () => {
  let cues = FITS;
  const { th, h } = await withTranscript({ site: { captions: () => ({ ok: true, value: cues }) } });
  const first = page("panel");
  await h.translate(first);
  const fingerprint = first.of("translate.started")[0]?.transcript.fingerprint;

  cues = OVERRUN;
  const refreshed = await th.service.get(REF, { mode: "full", fresh: true });
  assert.ok(refreshed.ok && refreshed.value.refreshMismatched, "告诉界面这次取到的对不上、留着原来的");
  const again = page("panel-2");
  await h.translate(again);
  assert.equal(h.requests(), 1, "没有为对不上的那份付费");
  assert.deepEqual(again.translated(fingerprint), first.translated());
});

test("强制刷新拿回同一条轨、分段没变：译文留着，再翻译直接交回，不再请求模型", async () => {
  const { th, h } = await withTranscript({ site: { captions: () => ({ ok: true, value: FITS }) } });
  const first = page("panel");
  await h.translate(first);
  assert.ok((await th.service.get(REF, { mode: "full", fresh: true })).ok);
  const again = page("panel-2");
  await h.translate(again);
  assert.equal(h.requests(), 1);
  assert.deepEqual(again.translated(), first.translated());
  assert.deepEqual(again.of("translate.segments").map((event) => event.stored), [true]);
});

test("强制刷新后某一段原文变了：只丢那一段的译文", async () => {
  const lines: Cue[] = [
    { start: 0, duration: 2, text: "第一句。" },
    { start: 30, duration: 2, text: "第二句。" },
    { start: 60, duration: 2, text: "第三句。" },
  ];
  let cues = lines;
  const { th, h } = await withTranscript({ site: { captions: () => ({ ok: true, value: cues }) } });
  const first = page("panel");
  await h.translate(first);
  assert.ok(Object.keys(first.translated()).length >= 2, "至少两段，才看得出只丢了一段");

  cues = lines.map((line, index) => (index === lines.length - 1 ? { ...line, text: "改过的最后一句。" } : line));
  assert.ok((await th.service.get(REF, { mode: "full", fresh: true })).ok);
  const again = page("panel-2");
  await h.translate(again);
  const kept = again.of("translate.segments").find((event) => event.stored);
  const changed = Object.keys(first.translated()).filter((id) => !(id in (kept?.translated ?? {})));
  assert.equal(changed.length, 1, "只丢了一段");
  for (const [id, text] of Object.entries(kept?.translated ?? {})) assert.equal(text, first.translated()[id], "没变的段带过来了");
  const asked = batchOf(h.fake.calls.at(-1)?.request ?? { messages: [], maxTokens: 0 });
  assert.equal(asked.length, 1, "只译变了的那段");
  assert.match(asked[0]?.text ?? "", /改过的最后一句/);
});

test("强制刷新换了语言：旧轨道的译文一条不留", async () => {
  const { th, h } = await withTranscript();
  await h.translate(page("panel"));
  const english = await th.service.get(REF, { mode: "full", fresh: true, lang: "en-US" });
  assert.ok(english.ok && english.value.transcript.ref.lang === "en-US");
  const again = page("panel-2");
  await h.translate(again);
  assert.deepEqual(again.of("translate.segments").filter((event) => event.stored), []);
  assert.equal(again.of("translate.started")[0]?.target, "zh");
  assert.equal(again.of("translate.started")[0]?.transcript.lang, "en-US");
  assert.equal(h.requests(), 2, "英文这一版重新请求模型");
});

// ============================================================
// 真实的后台分发：传输层、端口
// ============================================================

const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model" };
const GATEWAY_ORIGIN = "https://gateway.example.com/";
const OPENAI_ORIGIN = "https://api.openai.com/";

/** 请求体里出现的分段编号。 */
const idsIn = (request: SentRequest): string[] => [...new Set(JSON.stringify(request.body).match(/segment-\d+-\d+/g) ?? [])];

const translatedReply = (request: SentRequest, text = "Hello everyone, welcome to this video.") =>
  chatReply(JSON.stringify({ segments: idsIn(request).map((id) => ({ id, text })) }));

interface BackgroundOptions {
  readonly cues?: readonly Cue[];
  readonly durationSec?: number;
  readonly settings?: Record<string, unknown>;
  readonly origin?: string;
}

function background(handler: (request: SentRequest) => ReturnType<typeof reply> | Promise<ReturnType<typeof reply>>, options: BackgroundOptions = {}) {
  const ai = modelService(handler);
  const cues = options.cues ?? [{ start: 0, duration: 2, text: "大家好今天聊聊" }];
  const site = fakeSiteService({
    videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref, { durationSec: options.durationSec ?? 120 }) }),
    captions: () => ({ ok: true, value: [...cues] }),
  });
  const origin = options.origin ?? GATEWAY_ORIGIN;
  const fake = createFakeChrome({
    ...keyedStorage(options.settings ?? GATEWAY, origin),
    grantedOrigins: [origin],
    fetch: ai.fetch,
    prompts: { "translation.md": TRANSLATION_PROMPT },
    site: site.service,
  });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  fake.chrome.runtime.onConnect.addListener(((port: FakePort) => app.connect(port as never)) as never);
  fake.chrome.storage.onChanged.addListener(((changes: never, area: string) => void app.onStorageChanged(changes, area)) as never);
  return { ai, site, fake, app };
}

const eventsOf = (port: FakePort) => port.posted as TranslateOut[];
/** 等后台往这个端口推一条满足条件的消息：推的那一刻就放行，不数轮次。 */
function posted(port: FakePort, matches: (message: unknown) => boolean): Promise<true> {
  if (port.posted.some(matches)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const original = port.postMessage.bind(port);
    port.postMessage = (message) => {
      original(message);
      if (matches(message)) resolve(true);
    };
  });
}

const finished = (port: FakePort) =>
  posted(port, (message) => ["translate.done", "translate.refused"].includes((message as { type?: string }).type ?? ""));

test("OpenAI 官方走 Responses 时，翻译批次按 segment_batch 的 schema 请求", async () => {
  const bg = background(
    (request) => RESP.asFetchResponse(RESP.completed(JSON.stringify({ segments: idsIn(request).map((id) => ({ id, text: "Hi everyone, let's chat today." })) }))),
    { settings: { presetId: "openai", aiModel: "gpt-6-astra" }, origin: OPENAI_ORIGIN },
  );
  const port = bg.fake.connect("translate", senders.panel());
  port.send({ type: "translate.start", video: VIDEO });
  assert.ok(await finished(port));
  const segments = eventsOf(port).filter((event) => event.type === "translate.segments");
  assert.deepEqual(segments.map((event) => Object.values(event.translated)), [["Hi everyone, let's chat today."]]);
  const [sent] = bg.ai.posts();
  assert.equal(sent?.url, "https://api.openai.com/v1/responses");
  const body = sent?.body as { text: { format: { type: string; name: string } }; store: boolean };
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "segment_batch");
  assert.equal(body.store, false);
  assert.equal("temperature" in (sent?.body ?? {}), false, "推理模型不发 temperature");
});

/** 7 句，按分批规则分成两批：前 4 段一批，后 3 段一批。 */
const SEVEN: Cue[] = Array.from({ length: 7 }, (_, index) => ({ start: index * 30, duration: 5, text: `第${index + 1}段讲的是一件事情，内容比较长一些。` }));

test("翻译补轮里的那一批只发一次：空响应不加码、不脱掉 JSON 模式", async () => {
  const bodies = new Map<string, SentRequest[]>();
  let failed = false;
  const bg = background(
    (request) => {
      const first = idsIn(request)[0] ?? "";
      bodies.set(first, [...(bodies.get(first) ?? []), request]);
      if (first.startsWith("segment-0-")) return translatedReply(request);
      // 后一批：第一次碰上服务出错，补轮那次回空。
      if (!failed) {
        failed = true;
        return reply({ error: { message: "服务出错" } }, 500);
      }
      return chatReply("");
    },
    { cues: SEVEN, durationSec: 240 },
  );
  const port = bg.fake.connect("translate", senders.panel());
  port.send({ type: "translate.start", video: VIDEO });
  assert.ok(await eventually(() => bg.fake.timers.due(TRANSLATE_RETRY_DELAY_MS) === 1), "等一会儿补一轮");
  bg.fake.timers.fire(TRANSLATE_RETRY_DELAY_MS);
  assert.ok(await finished(port));
  const later = [...bodies.entries()].find(([id]) => !id.startsWith("segment-0-"))?.[1] ?? [];
  assert.equal(later.length, 2, "出错那次加补轮那次，补轮里空响应不再自己重发");
  assert.deepEqual(later[1]?.body?.response_format, later[0]?.body?.response_format, "没脱掉 JSON 模式");
  assert.equal(later[1]?.body?.max_tokens, later[0]?.body?.max_tokens, "没加码");
  const end = eventsOf(port).find((event) => event.type === "translate.done");
  assert.equal(end?.type === "translate.done" && end.failedBatches, 1);
});

test("翻译批次自己重发过、回来的还是读不出的 JSON：补轮不再发这一批", async () => {
  let sends = 0;
  const bg = background(
    (request) => {
      if (idsIn(request)[0]?.startsWith("segment-0-")) return translatedReply(request);
      sends += 1;
      return chatReply(sends === 1 ? "" : "{segments: [oops");
    },
    { cues: SEVEN, durationSec: 240 },
  );
  const port = bg.fake.connect("translate", senders.panel());
  port.send({ type: "translate.start", video: VIDEO });
  assert.ok(await finished(port));
  assert.equal(sends, 2, "传输层自己重发了一次");
  assert.equal(bg.fake.timers.due(TRANSLATE_RETRY_DELAY_MS), 0, "重试额度用掉了，不再补");
  const end = eventsOf(port).find((event) => event.type === "translate.done");
  assert.equal(end?.type === "translate.done" && end.failedBatches, 1);
});

test("翻译端口只收侧边栏：放行规则等于允许矩阵里那一行，别的页面连上就断开", async () => {
  const spec = createPorts({ translate: { start: async () => {}, stop() {}, leave() {} } }).translate;
  const expected = ROUTE_MATRIX.find((row) => row.name === "translate" && row.port);
  assert.ok(spec && expected);
  assert.deepEqual(
    { panel: spec.senders.includes("panel"), page: spec.senders.includes("page"), card: spec.senders.includes("card"), beforeEnable: spec.beforeEnable === true },
    { panel: expected.panel, page: expected.options || expected.triage, card: expected.card, beforeEnable: expected.beforeEnable },
  );

  const bg = background((request) => translatedReply(request));
  for (const sender of [senders.options(), senders.triage(), senders.card(), senders.content()]) {
    const port = bg.fake.connect("translate", sender);
    assert.equal(port.disconnected, true);
  }
  assert.equal(bg.ai.posts().length, 0);
});

test("端口里发起翻译的消息每条重查启用：确认失效以后再发起，站点和模型一个请求都不发", async () => {
  const bg = background((request) => translatedReply(request));
  const port = bg.fake.connect("translate", senders.panel());
  // 形状不对的消息只在连上以后才回：收到这条说明端口已经过了连接时的核对。
  port.send({ type: "translate.bogus" });
  assert.ok(await posted(port, () => true));
  // 确认失效了，存储变化的通知还没到：端口还连着。
  bg.fake.local.data[SETTINGS_STORAGE_KEY] = { ...(bg.fake.local.data[SETTINGS_STORAGE_KEY] as object), ...STALE_CONFIRMATION };
  port.send({ type: "translate.start", video: VIDEO });
  assert.ok(await eventually(() => port.disconnected));
  assert.deepEqual(port.posted, [
    { type: "port.error", code: "INVALID_REQUEST" },
    { type: "port.error", code: "NOT_ENABLED" },
  ]);
  assert.equal(bg.site.calls.length, 0);
  assert.equal(bg.ai.posts().length, 0);
});

test("真实端口：面板关掉后在途的几批照常存下，排着的批次不再发", async () => {
  const fourteen: Cue[] = Array.from({ length: 14 }, (_, index) => ({ start: index * 30, duration: 5, text: `第${index + 1}段讲的是一件事情，内容比较长一些。` }));
  const gate = deferred();
  const threeSent = deferred();
  let sent = 0;
  const bg = background(
    async (request) => {
      sent += 1;
      if (sent === 3) threeSent.resolve();
      await gate.promise;
      return translatedReply(request);
    },
    { cues: fourteen, durationSec: 450 },
  );
  const port = bg.fake.connect("translate", senders.panel());
  port.send({ type: "translate.start", video: VIDEO });
  await threeSent.promise;
  assert.equal(bg.ai.posts().length, 3, "并发上限三批在途");
  const listed = async () => {
    const reply = await bg.app.dispatch({ type: "task.list", req: {} }, senders.panel());
    return reply.ok ? (reply.value as { tasks: unknown[] }).tasks.length : -1;
  };
  port.close();
  gate.resolve();
  assert.ok(await eventually(async () => (await listed()) === 0), "在途的回来以后任务收尾");
  await nextTurn();
  assert.equal(bg.ai.posts().length, 3, "第四批没发");

  // 重开面板：在途那三批付过费、存下了，只剩最后两段要译。
  const reopened = bg.fake.connect("translate", senders.panel());
  reopened.send({ type: "translate.start", video: VIDEO });
  assert.ok(await finished(reopened));
  const kept = eventsOf(reopened).find((event) => event.type === "translate.segments" && event.stored);
  assert.equal(kept?.type === "translate.segments" && Object.keys(kept.translated).length, 12);
  const started = eventsOf(reopened).find((event) => event.type === "translate.started");
  assert.equal(started?.type === "translate.started" && started.pending, 2);
});
