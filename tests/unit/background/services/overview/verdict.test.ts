// 用官方总结写一句话结论：只发一次很小的请求，结论记下依据的那一版官方总结；已有结论不再花钱；依据字幕写的结论优先；
// 同一视频的等价请求接上在跑的那次；停止只撤还没发出去的；清除本机数据后不写回；和概览共用一道并发闸门。
// 任务运行器、概览仓储、清除闸门和并发闸门都是真的，模型服务和字幕是替身；走后台分发的几条用真实的路由和接线。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "../../../../../src/background/app.ts";
import { PROTOCOLS } from "../../../../../src/core/ai/provider/index.ts";
import { createLimiter, type Limiter } from "../../../../../src/core/concurrency.ts";
import type { OverviewRecord } from "../../../../../src/core/notes/records.ts";
import type { CompletionRequest } from "../../../../../src/core/ai/transport/index.ts";
import type { OverviewResultView } from "../../../../../src/shared/messages/overview.ts";
import type { Cue, OfficialSummary } from "../../../../../src/sites/types.ts";
import { createFakeChrome, senders } from "../../../../helpers/chrome.ts";
import { deferred, nextTurn } from "../../../../helpers/deferred.ts";
import { chatReply, keyedStorage, modelService, type SentRequest } from "../../../../helpers/fake-model-service.ts";
import { fakeSiteService } from "../../../../helpers/fake-site-service.ts";
import {
  codeOf,
  OFFICIAL,
  OTHER,
  overviewHarness,
  START,
  titles,
  value,
  VERDICT_GEN,
  verdictReply,
  VIDEO,
  type Respond,
} from "../../../../helpers/overview-service.ts";
import { harness as transcriptHarness, KEY as TRANSCRIPT_KEY, REF as TRANSCRIPT_REF } from "../../../../helpers/transcript-service.ts";
import { stillFalse, until } from "../../../../helpers/wait-until.ts";

const OFFICIAL_REPLY = verdictReply("官方说讲了两段", "看概览就够");
const officialOnly: Respond = ({ isVerdict }) => (isVerdict ? OFFICIAL_REPLY : undefined);
const isOfficialAsk = (user: string): boolean => user.includes("全片概述");

const record = (analysis: OverviewRecord["analysis"], extra: Partial<OverviewRecord> = {}): OverviewRecord => ({
  schemaVersion: 1,
  videoKey: VIDEO,
  snapshot: { title: "测试视频", author: "UP 主" },
  analysis,
  updatedAt: START - 1000,
  ...extra,
});

/** 结果在测试放行别的东西之前就出来了。 */
function settles<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(() => (settled = true));
  return () => settled;
}

// ============================================================
// 基本流程
// ============================================================

test("用官方总结写结论：只发一次结论请求，提纲当章节，结论标来源并随概览落库", async () => {
  const h = overviewHarness({ respond: officialOnly });
  const { taskId, result } = h.officialVerdict();
  const done = value(await result);

  assert.equal(h.asks.length, 1, "只有一次结论请求，不生成概览");
  const [ask] = h.verdictAsks();
  assert.ok(ask?.user.includes("全片概述：官方总摘要\n[1:05] 第一段：要点一；要点二\n没有时间"), "没有时间戳的段落不标成片头");
  assert.match(ask?.user ?? "", /金句：（无）/);
  assert.match(ask?.user ?? "", /覆盖：.*B站官方 AI 总结/);
  assert.match(ask?.user ?? "", /时长：10:00/);

  assert.deepEqual(done.analysis.chapters, []);
  assert.deepEqual(done.analysis.keyQuotes, []);
  assert.equal(done.analysis.verdict?.summary, "官方说讲了两段");
  assert.equal(done.analysis.verdict?.source, "official");
  assert.equal(done.analysis.verdict?.incomplete, undefined);
  assert.equal(done.fromCache, false);

  const stored = await h.record();
  assert.equal(stored?.analysis.verdict?.source, "official", "存进概览仓储");
  assert.deepEqual(stored?.parts?.verdict, {
    derived: { basis: { source: "official-summary", video: VIDEO, fingerprint: OFFICIAL.fingerprint }, gen: { feature: "verdict", promptVersion: VERDICT_GEN.promptVersion, model: VERDICT_GEN.model, effort: "off" } },
    taskCreatedAt: START,
  });
  assert.equal(stored?.parts?.chapters, undefined, "只写结论这一部分");
  assert.deepEqual(h.updates(), [{ type: "overview.updated", video: VIDEO, verdictPending: false }]);
  assert.equal(h.tasks.list().length, 0, "任务收尾");
  assert.equal(h.progress().filter((task) => task.state !== "running").at(-1)?.id, await taskId);
});

test("用官方总结写结论的请求在途时清除了本机数据：回来的结论不再落库", async () => {
  const sent = deferred();
  const reply = deferred();
  const h = overviewHarness({
    respond: async ({ isVerdict }) => {
      if (!isVerdict) return undefined;
      sent.resolve();
      await reply.promise;
      return OFFICIAL_REPLY;
    },
  });
  const { result } = h.officialVerdict();
  await sent.promise;
  await h.guard.clear("all", async () => {});
  reply.resolve();
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(await h.record(), null);
  assert.deepEqual(h.updates(), []);
});

test("已经有结论时不再用官方总结重写，原样返回", async () => {
  const existing = record({ chapters: [{ title: "旧章", timestampSeconds: 0 }], keyQuotes: [], verdict: { summary: "模型写的", verdict: "可以跳过" } });
  const h = overviewHarness({ records: [existing] });
  const done = value(await h.officialVerdict().result);
  assert.equal(done.fromCache, true);
  assert.equal(done.analysis.verdict?.summary, "模型写的");
  assert.equal(h.asks.length, 0, "不花钱");
  assert.equal(h.reads(), 0, "连字幕都不取");
});

test("没有 B站官方总结时明确报错，不发请求", async () => {
  for (const official of [
    { status: "none", summary: "", outline: [] },
    { status: "queued", summary: "", outline: [] },
    { status: "pending", summary: "", outline: [] },
    { status: "ok", summary: " ", outline: [] },
  ] as const) {
    const h = overviewHarness({ official });
    assert.equal(codeOf(await h.officialVerdict().result), "NO_OFFICIAL_SUMMARY", official.status);
    assert.equal(h.asks.length, 0);
  }
  const absent = overviewHarness({ official: null });
  assert.equal(codeOf(await absent.officialVerdict().result), "NO_OFFICIAL_SUMMARY");
});

test("用官方总结写结论时 AI 没配好，把真实原因告诉用户", async () => {
  const h = overviewHarness();
  h.setFailMode("all");
  assert.equal(codeOf(await h.officialVerdict().result), "NO_AI_CONFIG");
  assert.equal(h.verdictAsks().length, 1, "试的是结论请求");
  assert.equal(h.chunkAsks().length, 0, "没有去生成概览");
});

test("模型没写出有效结论时报空结论，不往概览里存东西", async () => {
  const h = overviewHarness({ respond: ({ isVerdict }) => (isVerdict ? { text: "不是 JSON" } : undefined) });
  assert.equal(codeOf(await h.officialVerdict().result), "EMPTY_VERDICT");
  assert.equal(await h.record(), null);
});

test("读不到字幕、只带回官方总结和视频信息时照样写结论；带不回官方总结时报原来的错", async () => {
  const h = overviewHarness({ respond: officialOnly, captionsFail: { ok: false, code: "NO_CAPTIONS" } });
  const done = value(await h.officialVerdict().result);
  assert.equal(done.analysis.verdict?.source, "official");
  assert.match(h.verdictAsks()[0]?.user ?? "", /时长：10:00/, "没有字幕时长按视频信息算");

  const limited = overviewHarness({ official: null, captionsFail: { ok: false, code: "RATE_LIMITED", retryAfterSec: 60 } });
  assert.deepEqual(await limited.officialVerdict().result, { ok: false, code: "RATE_LIMITED", retryAfterSec: 60 }, "只带失败本身");
  const none = overviewHarness({ official: { status: "none", summary: "", outline: [] }, captionsFail: { ok: false, code: "NO_CAPTIONS" } });
  assert.equal(codeOf(await none.officialVerdict().result), "NO_OFFICIAL_SUMMARY");
  assert.equal(limited.asks.length + none.asks.length, 0);
});

test("只认登记成结论、而且是这个视频的任务：概览任务、别的视频的任务、没登记的任务号都不认", async () => {
  const h = overviewHarness({ respond: officialOnly });
  const overviewTask = await h.register();
  assert.equal(codeOf(await h.verdict.fromOfficial(overviewTask, VIDEO)), "TASK_NOT_FOUND");
  const other = await h.registerVerdict({ video: OTHER });
  assert.equal(codeOf(await h.verdict.fromOfficial(other, VIDEO)), "TASK_NOT_FOUND");
  assert.equal(codeOf(await h.verdict.fromOfficial("没登记", VIDEO)), "TASK_NOT_FOUND");
  assert.equal(codeOf(await h.verdict.fromOfficial(other, "不是视频键" as typeof VIDEO)), "INVALID_REQUEST");
  assert.equal(h.asks.length, 0);
});

// ============================================================
// 和完整概览的结论谁留下
// ============================================================

test("只有官方总结写的结论时不算已有概览：照常生成，结论以完整概览为准", async () => {
  const h = overviewHarness({ respond: officialOnly });
  value(await h.officialVerdict().result);
  h.setRespond(({ isVerdict }) => (isVerdict ? verdictReply("按字幕讲了两段", "可以跳过") : undefined));

  const done = value(await h.generate().result);
  assert.equal(done.fromCache, false, "不能把只有结论的那份当成已有的概览");
  assert.equal(done.analysis.chapters?.length, 2);
  assert.equal(done.analysis.verdict?.summary, "按字幕讲了两段");
  assert.equal(done.analysis.verdict?.source, undefined);
  const stored = await h.record();
  assert.equal(stored?.analysis.verdict?.summary, "按字幕讲了两段");
  assert.equal(stored?.parts?.verdict?.derived.basis.source, "transcript");
});

test("完整概览的结论没写成时，接着用官方总结写的那条", async () => {
  const h = overviewHarness({ respond: officialOnly });
  value(await h.officialVerdict().result);
  h.setRespond(({ isVerdict }) => (isVerdict ? { text: "{}" } : undefined));

  const done = value(await h.generate().result);
  assert.equal(done.analysis.chapters?.length, 2);
  assert.equal(done.analysis.verdict?.summary, "官方说讲了两段");
  assert.equal(done.analysis.verdict?.source, "official");
  const stored = await h.record();
  assert.deepEqual(titles(stored), ["章@0", "章@150"]);
  assert.equal(stored?.analysis.verdict?.source, "official", "落库的也接上了");
  assert.equal(stored?.parts?.verdict?.derived.basis.source, "official-summary");
});

test("等官方总结结论的工夫完整概览已经写好结论：以完整概览为准，不覆盖", async () => {
  const sent = deferred();
  const reply = deferred();
  const h = overviewHarness({
    respond: async ({ isVerdict, user }) => {
      if (!isVerdict) return undefined;
      if (!isOfficialAsk(user)) return verdictReply("按字幕写的", "可以跳过");
      sent.resolve();
      await reply.promise;
      return OFFICIAL_REPLY;
    },
  });
  const { result } = h.officialVerdict();
  await sent.promise;
  const generated = value(await h.generate().result);
  assert.equal(generated.analysis.verdict?.summary, "按字幕写的");
  const updates = h.updates().length;
  reply.resolve();

  const done = value(await result);
  assert.equal(done.analysis.verdict?.summary, "按字幕写的", "交回生效中的那份");
  assert.equal((await h.record())?.analysis.verdict?.summary, "按字幕写的");
  assert.equal(h.updates().length, updates, "没写就不广播");
});

test("没记来历的旧结论不是官方总结写的：等官方结论的工夫被写进来，同样不覆盖", async () => {
  const sent = deferred();
  const reply = deferred();
  const h = overviewHarness({
    respond: async ({ isVerdict }) => {
      if (!isVerdict) return undefined;
      sent.resolve();
      await reply.promise;
      return OFFICIAL_REPLY;
    },
  });
  const { result } = h.officialVerdict();
  await sent.promise;
  await h.store.put(record({ chapters: [{ title: "导入的章", timestampSeconds: 0 }], keyQuotes: [], verdict: { summary: "旧备份里的结论" } }));
  reply.resolve();
  assert.equal(value(await result).analysis.verdict?.summary, "旧备份里的结论");
  assert.equal((await h.record())?.parts, undefined);
});

test("用官方总结写结论时换了字幕语言：结论照常写进去，缓存里换过的字幕不被旧快照盖掉", async () => {
  const official: OfficialSummary = { status: "ok", summary: "官方总摘要", outline: [{ title: "第一段", timestamp: 5, points: [{ timestamp: 5, content: "要点" }] }], cues: [] };
  const transcript = transcriptHarness({ site: { officialSummary: () => ({ ok: true, value: official }) } });
  const h = overviewHarness({
    transcript: transcript.service,
    respond: async ({ isVerdict }) => {
      if (!isVerdict) return undefined;
      // 结论请求在途时侧边栏换到了英文轨，缓存里随之换成英文字幕。
      assert.ok((await transcript.service.get(TRANSCRIPT_REF, { mode: "full", lang: "en-US" })).ok);
      return OFFICIAL_REPLY;
    },
  });
  const done = value(await h.verdict.fromOfficial(await h.registerVerdict({ video: TRANSCRIPT_KEY }), TRANSCRIPT_KEY));
  assert.equal(done.analysis.verdict?.source, "official");
  const [row] = await transcript.rows();
  assert.equal(row?.transcript?.ref.lang, "en-US", "缓存里是换过的那条轨");
  assert.equal((await h.record(TRANSCRIPT_KEY))?.analysis.verdict?.source, "official");
});

// ============================================================
// 同一视频只写一份
// ============================================================

/** 结论请求挂住，等测试放行；数发了几次。 */
function heldVerdicts(extra: Parameters<typeof overviewHarness>[0] = {}) {
  const reply = deferred();
  const h = overviewHarness({
    ...extra,
    respond: async ({ isVerdict }) => {
      if (!isVerdict) return undefined;
      await reply.promise;
      return OFFICIAL_REPLY;
    },
  });
  return { h, release: reply.resolve };
}

test("粗筛和侧边栏同时给同一个视频写官方结论：只发一次请求，两边都拿到结论", async () => {
  const { h, release } = heldVerdicts();
  const fromTriage = h.officialVerdict({ kind: "triage-verdict", origin: "batch" }).result;
  assert.ok(await until(() => h.verdictAsks().length === 1));
  const fromPanel = h.officialVerdict().result;
  assert.ok(await until(() => h.reads() === 2), "后到的也读完了材料");
  // 给后到的一点机会：它要是自己发，会在这里发出第二次请求。
  assert.ok(await stillFalse(() => h.verdictAsks().length > 1));
  release();
  const [a, b] = await Promise.all([fromTriage, fromPanel]);
  assert.equal(value(a).analysis.verdict?.summary, "官方说讲了两段");
  assert.equal(value(b).analysis.verdict?.summary, "官方说讲了两段");
  assert.equal(h.verdictAsks().length, 1);
});

test("排在后面的粗筛结论被停止：不等前一个写完，马上按已取消结束", async () => {
  const { h, release } = heldVerdicts();
  const first = h.officialVerdict().result;
  assert.ok(await until(() => h.verdictAsks().length === 1));
  const queued = h.officialVerdict({ kind: "triage-verdict", origin: "batch" });
  const taskId = await queued.taskId;
  assert.ok(await until(() => h.reads() === 2));
  assert.ok(await stillFalse(() => h.verdictAsks().length > 1));
  h.tasks.cancel(taskId);
  const done = settles(queued.result);
  assert.ok(await until(done), "不等前一个写完");
  assert.equal(codeOf(await queued.result), "TASK_CANCELED");
  release();
  assert.equal((await first).ok, true);
  assert.equal(h.verdictAsks().length, 1);
});

test("排在后面的被停止后，再来一个同视频的结论：仍排在还没写完的那个后头，不并发再付一次", async () => {
  const { h, release } = heldVerdicts();
  const first = h.officialVerdict().result;
  assert.ok(await until(() => h.verdictAsks().length === 1));
  const queued = h.officialVerdict({ kind: "triage-verdict", origin: "batch" });
  const queuedId = await queued.taskId;
  assert.ok(await until(() => h.reads() === 2));
  assert.ok(await stillFalse(() => h.verdictAsks().length > 1), "排上了，没有自己发");
  h.tasks.cancel(queuedId);
  assert.ok(await until(settles(queued.result)), "被停止的马上收尾");
  assert.equal(codeOf(await queued.result), "TASK_CANCELED");

  const third = h.officialVerdict({ kind: "triage-verdict", origin: "batch" }).result;
  assert.ok(await until(() => h.reads() === 3));
  // 被停止的那个离开时要是把在途的那次一起撤了，第三个看不到前面还在写，会发第二次请求。
  assert.ok(await stillFalse(() => h.verdictAsks().length > 1));
  release();
  const results = await Promise.all([first, third]);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(h.verdictAsks().length, 1);
});

test("生成配置不一样的同视频结论：等前一个写完，看到已有结论就直接用，不再发请求", async () => {
  const { h, release } = heldVerdicts();
  const first = h.officialVerdict().result;
  assert.ok(await until(() => h.verdictAsks().length === 1));
  const other = await h.tasks.register({ kind: "triage-verdict", origin: "batch", video: VIDEO, gen: { ...VERDICT_GEN, model: "另一个型号" }, followsPage: false }, {});
  assert.ok("task" in other);
  const second = h.verdict.fromOfficial(other.task.id, VIDEO);
  assert.ok(await until(() => h.reads() === 2));
  assert.ok(await stillFalse(() => h.verdictAsks().length > 1));
  release();
  assert.equal((await first).ok, true);
  const done = value(await second);
  assert.equal(done.fromCache, true);
  assert.equal(h.verdictAsks().length, 1);
});

test("前一个写完之后才来的同视频结论：读到已有结论，不再发请求", async () => {
  const h = overviewHarness({ respond: officialOnly });
  value(await h.officialVerdict().result);
  const again = value(await h.officialVerdict({ kind: "triage-verdict", origin: "batch" }).result);
  assert.equal(again.fromCache, true);
  assert.equal(h.verdictAsks().length, 1);
});

// ============================================================
// 停止和排队
// ============================================================

test("两份概览服务注入同一道闸门：同时跑时发往模型的请求合起来不超过并发上限", async () => {
  let inflight = 0;
  let peak = 0;
  const reply = deferred();
  const h = overviewHarness({
    concurrency: 2,
    respond: async ({ isVerdict }) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await reply.promise;
      inflight -= 1;
      return isVerdict ? OFFICIAL_REPLY : undefined;
    },
  });
  // 概览两块并发生成，同时用官方总结写结论。
  const overview = h.generate({ video: VIDEO }).result;
  const verdict = h.verdict.fromOfficial(await h.registerVerdict(), VIDEO);
  assert.ok(await until(() => inflight === 2));
  assert.ok(await stillFalse(() => h.asks.length > 2), "上限是 2，第三个排在闸门外");
  reply.resolve();
  assert.equal((await overview).ok, true);
  assert.equal((await verdict).ok, true);
  assert.equal(peak, 2, "两份服务合起来也只有两个请求在途");
});

test("用官方总结写结论被停止：排在闸门外的出队，不发给模型", async () => {
  const limiter = createLimiter();
  const atGate = deferred();
  let calls = 0;
  const gate: Limiter = (limit, task, options) => {
    calls += 1;
    if (calls > 1) atGate.resolve();
    return limiter(limit, task, options);
  };
  // 别处的一个请求占着唯一的名额，迟迟不回。
  const holder = deferred();
  const occupied = gate(1, () => holder.promise);
  const h = overviewHarness({ concurrency: 1, gate, respond: officialOnly });
  const { taskId, result } = h.officialVerdict();
  await atGate.promise;
  h.tasks.cancel(await taskId);

  const done = settles(result);
  assert.ok(await until(done), "排队中的结论请求要立刻响应停止，不等别人让出名额");
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(h.asks.length, 0, "没有发给模型");
  assert.deepEqual(h.logs, [], "停止不是故障，不报错误日志");

  holder.resolve();
  await occupied;
  await nextTurn();
  assert.equal(h.asks.length, 0, "名额空出来之后也不会再发");
  assert.equal(await h.record(), null, "什么都没存");
});

test("用官方总结写结论被停止：已经发给模型的不跟着中止，结论照常回来并存下", async () => {
  const sent = deferred();
  const reply = deferred();
  let request: CompletionRequest | undefined;
  const h = overviewHarness({
    respond: async (ask) => {
      if (!ask.isVerdict) return undefined;
      request = ask.request;
      sent.resolve();
      await reply.promise;
      return OFFICIAL_REPLY;
    },
  });
  const { taskId, result } = h.officialVerdict();
  await sent.promise;
  h.tasks.cancel(await taskId);
  reply.resolve();

  const done = value(await result);
  assert.equal(done.analysis.verdict?.summary, "官方说讲了两段");
  assert.ok(!request?.signal?.aborted, "发给模型的请求不跟着停止中止");
  assert.equal((await h.record())?.analysis.verdict?.source, "official", "钱已经花了，结论照常存下");
});

test("用官方总结写结论：算等价键的工夫被停止，恢复以后不再发请求", async () => {
  // 只拦写结论时算的那把键（带着官方总结的依据），登记任务时算的不拦。
  const subtle = globalThis.crypto.subtle;
  const digest = subtle.digest.bind(subtle);
  const keying = deferred();
  const release = deferred();
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (new TextDecoder().decode(data).includes('"source":"official-summary"')) {
        keying.resolve();
        await release.promise;
      }
      return digest(algorithm, data);
    },
  });
  try {
    const h = overviewHarness({ respond: officialOnly });
    const { taskId, result } = h.officialVerdict();
    await keying.promise;
    h.tasks.cancel(await taskId);
    release.resolve();
    assert.equal(codeOf(await result), "TASK_CANCELED");
    await nextTurn();
    assert.equal(h.asks.length, 0, "闸门有空位也不发");
    assert.equal(await h.record(), null);
  } finally {
    Reflect.deleteProperty(subtle, "digest");
  }
});

test("用官方总结写结论被停止：限流后的自动重发也听它的，停止时不再重发", async () => {
  const sent = deferred();
  const reply = deferred();
  let request: CompletionRequest | undefined;
  const h = overviewHarness({
    respond: async (ask) => {
      if (!ask.isVerdict) return undefined;
      request = ask.request;
      sent.resolve();
      await reply.promise;
      return OFFICIAL_REPLY;
    },
  });
  const { taskId, result } = h.officialVerdict();
  await sent.promise;
  assert.equal(request?.signal, undefined, "在途的请求不带停止信号");
  assert.equal(request?.retrySignal?.aborted, false);
  h.tasks.cancel(await taskId);
  assert.equal(request?.retrySignal?.aborted, true, "停止以后不再自动重发");
  reply.resolve();
  assert.equal((await result).ok, true);
});

// ============================================================
// 清除本机数据
// ============================================================

test("官方总结结论进了概览仓储的写队列、还没写时清除了本机数据：不重建，也不报成功", async () => {
  let queued!: () => void;
  const reached = new Promise<void>((resolve) => (queued = resolve));
  const h = overviewHarness({
    respond: officialOnly,
    wrapStore: (inner) => ({
      ...inner,
      updateRecord(key, plan, options) {
        const writing = inner.updateRecord(key, plan, options);
        if (key === VIDEO) queued();
        return writing;
      },
    }),
  });
  // 前面占着写队列的一项，放行前结论的保存只能排队等着。
  const ahead = deferred();
  const blocker = h.store.updateRecord(OTHER, async () => {
    await ahead.promise;
    return {};
  });
  const { result } = h.officialVerdict();
  await reached;
  const clearing = h.guard.clear("all", async () => {});
  ahead.resolve();
  await blocker;
  await clearing;
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(await h.record(), null);
});

test("官方总结结论排队期间清除了本机数据：轮到时按排队前的清除代数判断，不取字幕、不发请求", async () => {
  const h = overviewHarness({ respond: officialOnly });
  const since = h.guard.epoch();
  await h.guard.clear("all", async () => {});
  assert.ok(since);
  assert.equal(codeOf(await h.officialVerdict({ since }).result), "TASK_CANCELED");
  assert.equal(h.reads(), 0);
  assert.equal(h.asks.length, 0);
  assert.equal(await h.record(), null);
});

test("官方总结结论已经开始、还在读本机记录时清除了本机数据：不再取字幕、不发请求", async () => {
  const reading = deferred();
  const released = deferred();
  const h = overviewHarness({
    respond: officialOnly,
    wrapStore: (inner) => ({
      ...inner,
      async find(key) {
        reading.resolve();
        await released.promise;
        return inner.find(key);
      },
    }),
  });
  const { result } = h.officialVerdict();
  await reading.promise;
  await h.guard.clear("all", async () => {});
  released.resolve();
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(h.reads(), 0, "不再取字幕");
  assert.equal(h.asks.length, 0, "没有发模型请求");
});

test("官方总结结论排在请求闸门外时清除了本机数据：轮到时不再发请求", async () => {
  const queued = deferred();
  const released = deferred();
  const h = overviewHarness({
    respond: officialOnly,
    // 闸门满着：结论请求排在外面，放行前设置页清除了数据。
    gate: async (_limit, task) => {
      queued.resolve();
      await released.promise;
      return task();
    },
  });
  const { result } = h.officialVerdict();
  await queued.promise;
  await h.guard.clear("all", async () => {});
  released.resolve();
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(h.asks.length, 0, "没有发模型请求");
});

test("官方总结结论交给传输层的 stillWanted 跟着清除代数走：清除后传输层不再发、不再重发", async () => {
  let stillWanted: (() => boolean) | null | undefined;
  const h = overviewHarness({
    respond: ({ isVerdict, request }) => {
      if (!isVerdict) return undefined;
      stillWanted = request.stillWanted;
      return OFFICIAL_REPLY;
    },
  });
  value(await h.officialVerdict().result);
  assert.equal(typeof stillWanted, "function");
  assert.equal(stillWanted?.(), true);
  await h.guard.clear("all", async () => {});
  assert.equal(stillWanted?.(), false);
});

// ============================================================
// 走真实的后台分发
// ============================================================

const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model", analysisChunkMode: "short" };
const GATEWAY_ORIGIN = "https://gateway.example.com/";
const readPrompt = (file: string): string => readFileSync(new URL(`../../../../../prompts/${file}`, import.meta.url), "utf8").replaceAll("\r", "");
const PROMPT_FILES = { "analysis.md": readPrompt("analysis.md"), "verdict.md": readPrompt("verdict.md") };
const SITE_OFFICIAL: OfficialSummary = { status: "ok", summary: "官方总摘要", outline: [{ title: "第一段", timestamp: 5, points: [{ timestamp: 5, content: "要点" }] }], cues: [] };
const userOf = (request: SentRequest): string => {
  const messages = (request.body?.messages ?? []) as { readonly role: string; readonly content: string }[];
  return messages.find((message) => message.role === "user")?.content ?? "";
};
const isVerdictRequest = (request: SentRequest): boolean => userOf(request).includes("章节摘要");
const VERDICT_ANSWER = chatReply(JSON.stringify({ summary: "官方说讲了开场", value: "", verdict: "看概览就够", reason: "提纲都有" }));
const chunkAnswer = (request: SentRequest) => {
  const seconds = Number(/（第 (\d+) 秒）/.exec(userOf(request))?.[1] ?? 0);
  return chatReply(JSON.stringify({ chapters: [{ title: "开场", timestampSeconds: seconds, summary: "摘要" }], keyQuotes: [] }));
};

function background(handler: (request: SentRequest) => ReturnType<typeof chatReply> | Promise<ReturnType<typeof chatReply>>, cues?: Cue[]) {
  const ai = modelService(handler);
  const site = fakeSiteService({ officialSummary: () => ({ ok: true, value: SITE_OFFICIAL }), ...(cues ? { captions: () => ({ ok: true, value: cues }) } : {}) });
  const fake = createFakeChrome({ ...keyedStorage(GATEWAY, GATEWAY_ORIGIN), grantedOrigins: [GATEWAY_ORIGIN], fetch: ai.fetch, prompts: PROMPT_FILES, site: site.service });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const ask = (type: string, req: unknown, sender = senders.panel()) => app.dispatch({ type, req }, sender) as Promise<{ readonly ok: boolean; readonly code?: string; readonly value?: never }>;
  async function start(kind: "verdict" | "overview"): Promise<{ readonly id: string; readonly joined: boolean }> {
    const started = (await ask("task.start", { kind, video: TRANSCRIPT_KEY })) as unknown as { ok: true; value: { task: { id: string }; joined: boolean } };
    assert.ok(started.ok, JSON.stringify(started));
    return { id: started.value.task.id, joined: started.value.joined };
  }
  const official = async (): Promise<{ readonly ok: boolean; readonly code?: string; readonly value?: OverviewResultView }> =>
    ask("verdict.fromOfficial", { video: TRANSCRIPT_KEY, taskId: (await start("verdict")).id }) as never;
  return { ai, site, app, ask, start, official };
}

test("用官方总结写结论的路由：只发一次结论请求，官方总结和提纲进了提示词，结论标来源并存进本机", async () => {
  const bg = background(() => VERDICT_ANSWER);
  const result = await bg.official();
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(bg.ai.posts().length, 1, "只发一次结论请求");
  const user = userOf(bg.ai.posts()[0] as SentRequest);
  assert.match(user, /全片概述：官方总摘要/);
  assert.match(user, /\[0:05\] 第一段：要点/);
  assert.equal(result.value?.analysis.verdict?.source, "official");
  assert.deepEqual(result.value?.analysis.chapters, []);
  const stored = (await bg.ask("overview.get", { video: TRANSCRIPT_KEY })) as unknown as { ok: true; value: { overview?: { analysis: OverviewRecord["analysis"] } } };
  assert.equal(stored.value.overview?.analysis.verdict?.summary, "官方说讲了开场");
});

test("用官方总结写结论的路由只收形状对的请求、只认登记成结论的任务", async () => {
  const bg = background(() => VERDICT_ANSWER);
  for (const req of [{ video: TRANSCRIPT_KEY }, { video: TRANSCRIPT_KEY, taskId: "" }, { video: TRANSCRIPT_KEY, taskId: "t", extra: 1 }, { video: "不是视频键", taskId: "t" }, null]) {
    assert.equal((await bg.ask("verdict.fromOfficial", req)).code, "INVALID_REQUEST", JSON.stringify(req));
  }
  const overview = await bg.start("overview");
  assert.equal((await bg.ask("verdict.fromOfficial", { video: TRANSCRIPT_KEY, taskId: overview.id })).code, "TASK_NOT_FOUND");
  assert.equal(bg.ai.posts().length, 0);
});

test("两个侧边栏同时点：也只发一次", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const bg = background(async () => {
    await gate.promise;
    return VERDICT_ANSWER;
  });
  const first = await bg.start("verdict");
  const pending = bg.ask("verdict.fromOfficial", { video: TRANSCRIPT_KEY, taskId: first.id });
  assert.ok(await until(() => bg.ai.posts().length === 1));
  const second = await bg.start("verdict");
  assert.equal(second.joined, true, "第二个侧边栏接上同一个任务");
  const again = bg.ask("verdict.fromOfficial", { video: TRANSCRIPT_KEY, taskId: second.id });
  assert.ok(await stillFalse(() => bg.ai.posts().length > 1));
  gate.resolve();
  const results = await Promise.all([pending, again]);
  assert.ok(results.every((result) => result.ok), JSON.stringify(results));
  assert.equal(bg.ai.posts().length, 1);
});

test("后台里概览和用官方总结写结论排同一道并发闸门：合起来同时在途的模型请求不超过上限", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const cues: Cue[] = [0, 150, 300, 450].map((start, index) => ({ start, duration: 120, text: `第${index}段。${"字".repeat(1800)}` }));
  const bg = background(async (request) => {
    await gate.promise;
    return isVerdictRequest(request) ? VERDICT_ANSWER : chunkAnswer(request);
  }, cues);
  const overviewTask = await bg.start("overview");
  const overview = bg.ask("overview.start", { video: TRANSCRIPT_KEY, taskId: overviewTask.id });
  assert.ok(await until(() => bg.ai.posts().length === 3), "概览先占满三个名额");
  const verdict = bg.official();
  assert.ok(await stillFalse(() => bg.ai.posts().length > 3), "结论排在同一道闸门外");
  gate.resolve();
  assert.equal((await overview).ok, true);
  assert.equal((await verdict).ok, true);
  assert.ok(bg.ai.posts().some((request) => userOf(request).includes("全片概述")), "官方总结写的结论请求最后也发了");
});
