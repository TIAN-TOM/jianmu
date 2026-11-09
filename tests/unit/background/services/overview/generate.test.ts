// 概览生成：分块并发、偶发失败自动补一轮、确定性失败不补、补失败块只补失败区间、章节先落库再写结论、
// 长视频边生成边广播临时概览、停止时保住付过费的块、清除本机数据后不写回、重新生成先写草稿、存不下也照样交回。
// 任务运行器、概览仓储、清除闸门和并发闸门都是真的，模型服务和字幕是替身；走后台分发的几条用真实的路由和接线。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "../../../../../src/background/app.ts";
import { ANALYSIS_CHUNK, VERDICT } from "../../../../../src/core/ai/schemas.ts";
import { PROTOCOLS } from "../../../../../src/core/ai/provider/index.ts";
import type { OverviewRecord } from "../../../../../src/core/notes/records.ts";
import type { VideoKey } from "../../../../../src/core/video-ref.ts";
import type { ObjectStoreDriver } from "../../../../../src/platform/idb.ts";
import type { Cue } from "../../../../../src/sites/types.ts";
import { createFakeChrome, senders } from "../../../../helpers/chrome.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { chatReply, keyedStorage, modelService, reply, SAMPLE_KEY, type SentRequest } from "../../../../helpers/fake-model-service.ts";
import { fakeSiteService } from "../../../../helpers/fake-site-service.ts";
import {
  abortable,
  chapterReply,
  codeOf,
  hang,
  OTHER,
  overviewHarness,
  START,
  threeSegments,
  titles,
  twoSegments,
  value,
  verdictReply,
  VIDEO,
  type OverviewHarness,
  type Reply,
} from "../../../../helpers/overview-service.ts";
import { harness as transcriptHarness, KEY as TRANSCRIPT_KEY, REF as TRANSCRIPT_REF } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const INTERVAL = 20_000;
const FAIL_CHUNK = (user: string): boolean => user.includes("FAIL标记");
const record = (analysis: OverviewRecord["analysis"], extra: Partial<OverviewRecord> = {}): OverviewRecord => ({
  schemaVersion: 1,
  videoKey: VIDEO,
  snapshot: { title: "测试视频", author: "UP 主" },
  analysis,
  updatedAt: START - 1000,
  ...extra,
});

async function stop(h: OverviewHarness, taskId: Promise<string>, reason?: unknown): Promise<void> {
  h.tasks.cancel(await taskId, reason);
}

// ============================================================
// 基本流程
// ============================================================

test("认不出的视频直接拒绝", async () => {
  const h = overviewHarness();
  const taskId = await h.register();
  assert.equal(codeOf(await h.service.generate(taskId, "不是视频键" as VideoKey, { fresh: false })), "INVALID_REQUEST");
  assert.equal(codeOf(await h.service.generate(taskId, OTHER, { fresh: false })), "TASK_NOT_FOUND", "别的视频登记的任务不认");
  assert.equal(h.asks.length, 0);
  assert.equal(h.ensures(), 0);
});

test("同一个概览任务开始两次（连点、两个面板接上同一个任务）：接上在跑的那次，每块和结论只请求一遍模型", async () => {
  const once = overviewHarness();
  value(await once.generate().result);
  const single = { chunks: once.chunkAsks().length, verdicts: once.verdictAsks().length };

  const h = overviewHarness();
  const taskId = await h.register();
  const [first, second] = await Promise.all([h.service.generate(taskId, VIDEO, { fresh: false }), h.service.generate(taskId, VIDEO, { fresh: false })]);
  assert.deepEqual(value(second), value(first), "两边拿到同一份结果");
  assert.deepEqual({ chunks: h.chunkAsks().length, verdicts: h.verdictAsks().length }, single);
});

test("本机已有概览时直接返回，不再请求模型", async () => {
  const h = overviewHarness({
    records: [record({ chapters: [{ title: "旧概览", timestampSeconds: 0 }], keyQuotes: [] }, { analysisFailures: [{ index: 0, startSeconds: 0, endSeconds: 10 }] })],
  });
  const result = value(await h.generate().result);
  assert.equal(result.fromCache, true);
  assert.deepEqual(titles(result), ["旧概览"]);
  assert.equal(result.failedChunks, 1);
  assert.equal(h.asks.length, 0);
  assert.equal(h.ensures(), 0, "连字幕都不取");
});

test("字幕缓存过期后概览照样读得到", async () => {
  // 字幕缓存是空的，平台这会儿也读不了：概览不在字幕缓存里，照样读得到。
  const transcript = transcriptHarness({ site: { videoInfo: () => ({ ok: false, code: "NEED_LOGIN" }) } });
  const h = overviewHarness({ transcript: transcript.service, records: [record({ chapters: [{ title: "长期", timestampSeconds: 0 }], keyQuotes: [] })] });
  const result = value(await h.generate().result);
  assert.equal(result.fromCache, true);
  assert.deepEqual(titles(result), ["长期"]);
  assert.deepEqual(await transcript.rows(), []);
  const stored = await h.service.get(VIDEO);
  assert.ok(stored.ok && stored.value.overview);
  assert.deepEqual(titles(stored.value.overview), ["长期"]);
  assert.equal(transcript.site.calls.length, 0);
});

test("没有可用分块时报无字幕", async () => {
  const h = overviewHarness({ segments: [] });
  assert.equal(codeOf(await h.generate().result), "NO_TRANSCRIPT");
});

test("两块全部成功：存进概览，失败数为零", async () => {
  const h = overviewHarness();
  const result = value(await h.generate().result);
  assert.equal(result.chunkCount, 2);
  assert.equal(result.failedChunks, 0);
  const stored = await h.record();
  assert.deepEqual(titles(stored), ["章@0", "章@150"]);
  const part = stored?.parts?.chapters;
  assert.equal(part?.taskCreatedAt, START, "章节记下写它的任务的创建时间");
  assert.equal(part?.derived.basis.source, "transcript");
  assert.equal(part?.derived.basis.source === "transcript" && part.derived.basis.transcript.fingerprint, "fingerprint-zh");
  assert.equal(part?.derived.gen?.model, "chunk-model");
});

test("概览落库只写概览：生成期间字幕缓存里新写进的内容原样留着", async () => {
  const transcript = transcriptHarness();
  let wrote = false;
  const h = overviewHarness({
    transcript: transcript.service,
    respond: async ({ isVerdict }) => {
      if (isVerdict || wrote) return undefined;
      wrote = true;
      // 生成期间别处往字幕缓存里写了新的分段：概览落库不能拿开始时的快照把它盖回去。
      await transcript.service.writer.update(TRANSCRIPT_KEY, (current) => (current ? { ...current, chapters: [{ title: "新写进的分段", start: 0, end: 10 }] } : null));
      return undefined;
    },
  });
  assert.equal(value(await h.service.generate(await h.register(TRANSCRIPT_KEY), TRANSCRIPT_KEY, { fresh: false })).failedChunks, 0);
  const [row] = await transcript.rows();
  assert.deepEqual(row?.chapters.map((chapter) => chapter.title), ["新写进的分段"]);
  assert.ok((await h.record(TRANSCRIPT_KEY))?.analysis.chapters?.length, "概览本身正常写入");
});

test("生成期间导入了字幕文件：概览照常写进去，但不拿旧字幕的快照补回缓存", async () => {
  const transcript = transcriptHarness();
  const srt = ["1", "00:00:01,000 --> 00:00:04,000", "导入的一句", ""].join("\n");
  let imported = false;
  const h = overviewHarness({
    transcript: transcript.service,
    respond: async ({ isVerdict }) => {
      if (isVerdict || imported) return undefined;
      imported = true;
      assert.ok((await transcript.service.importFile(TRANSCRIPT_REF, { name: "课程.srt", text: srt })).ok);
      return undefined;
    },
  });
  const before = await transcript.service.get(TRANSCRIPT_REF, { mode: "full" });
  assert.ok(before.ok);
  const result = value(await h.service.generate(await h.register(TRANSCRIPT_KEY), TRANSCRIPT_KEY, { fresh: false }));
  assert.ok(result.analysis.chapters?.length, "概览本身按视频算，照常写入");
  const [row] = await transcript.rows();
  assert.equal(row?.transcript, undefined, "旧字幕没被写回缓存");
  const basis = (await h.record(TRANSCRIPT_KEY))?.parts?.chapters?.derived.basis;
  assert.equal(basis?.source === "transcript" && basis.transcript.fingerprint, before.value.transcript.ref.fingerprint, "概览记下依据的是旧的那份字幕");
});

test("单块持续失败仍出结果，并如实记录失败区间", async () => {
  const h = overviewHarness();
  h.setFailMode("marker");
  const result = value(await h.generate().result);
  assert.equal(result.failedChunks, 1);
  const stored = await h.record();
  assert.equal(stored?.analysisFailures?.length, 1);
  assert.ok((stored?.analysisFailures?.[0]?.startSeconds ?? 0) > 0);
});

test("全军覆没时透出第一个真实错误", async () => {
  const h = overviewHarness();
  h.setFailMode("all");
  assert.equal(codeOf(await h.generate().result), "NO_AI_CONFIG", "配置错误应原样告诉用户");
});

test("补失败块只请求失败区间，成功后清空记录", async () => {
  const h = overviewHarness();
  h.setFailMode("marker");
  await h.generate().result;
  h.setFailMode(null);
  const before = h.chunkAsks().length;
  const result = value(await h.retry().result);
  assert.equal(result.failedChunks, 0);
  assert.equal(h.chunkAsks().length - before, 1, "只补失败的那一块");
  assert.equal((await h.record())?.analysisFailures, undefined);
});

test("还没有概览时补失败块明确拒绝", async () => {
  const h = overviewHarness();
  assert.equal(codeOf(await h.retry().result), "NO_ANALYSIS");
});

// ============================================================
// 章节先落库，结论单独写
// ============================================================

test("结论阶段被取消：章节已经落库并照常返回，只是没有结论", async () => {
  const started = deferred();
  const h = overviewHarness({
    respond: ({ isVerdict, request }) => {
      if (!isVerdict) return undefined;
      started.resolve();
      return hang(request.signal);
    },
  });
  const { taskId, result } = h.generate();
  await started.promise;
  await stop(h, taskId);
  const done = value(await result);
  assert.equal(done.verdictCanceled, true);
  assert.equal(done.analysis.verdict, undefined);
  assert.deepEqual(titles(done), ["章@0", "章@150"], "付过费的章节一章不少");
  assert.deepEqual(titles(await h.record()), ["章@0", "章@150"], "章节已经存下");
});

test("章节先存好并广播给侧边栏，结论写好后再补存", async () => {
  const gate = deferred();
  const h = overviewHarness({ respond: async ({ isVerdict }) => (isVerdict ? (await gate.promise, verdictReply()) : undefined) });
  const { result } = h.generate();
  assert.ok(await until(() => h.updates().length > 0), "章节合并好就广播一次，不等结论");
  assert.deepEqual(h.updates()[0], { type: "overview.updated", video: VIDEO, verdictPending: true });
  const early = await h.record();
  assert.deepEqual(titles(early), ["章@0", "章@150"], "写结论之前章节已经落库");
  assert.equal(early?.analysis.verdict, undefined);

  gate.resolve();
  assert.equal(value(await result).analysis.verdict?.verdict, "看概览就够");
  assert.equal((await h.record())?.analysis.verdict?.summary, "讲了两段", "结论写好后补存");
  assert.equal(h.updates().at(-1)?.verdictPending, false);
});

test("补失败块时结论阶段被取消：补上的章节照样保存", async () => {
  const h = overviewHarness();
  h.setFailMode("marker");
  await h.generate().result;
  h.setFailMode(null);
  const started = deferred();
  h.setRespond(({ isVerdict, request }) => {
    if (!isVerdict) return undefined;
    started.resolve();
    return hang(request.signal);
  });
  const { taskId, result } = h.retry();
  await started.promise;
  await stop(h, taskId);
  const done = value(await result);
  assert.equal(done.verdictCanceled, true);
  assert.equal(done.failedChunks, 0);
  assert.deepEqual(titles(done), ["章@0", "章@150"]);
  const stored = await h.record();
  assert.deepEqual(titles(stored), ["章@0", "章@150"], "补上的章节已经落库");
  assert.equal(stored?.analysisFailures, undefined, "失败区间已清掉");
});

test("分块返回空对象时记为失败块，不把缺了一段的概览当成完整的", async () => {
  const h = overviewHarness({ respond: ({ user, isVerdict }) => (!isVerdict && FAIL_CHUNK(user) ? { text: "{}" } : undefined) });
  const result = value(await h.generate().result);
  assert.equal(result.failedChunks, 1, "空分块要算进失败数");
  assert.equal(result.analysisFailures[0]?.startSeconds, 150);
  assert.match(result.analysisFailures[0]?.reason ?? "", /没有产出有效的章节或金句/);
  assert.equal((await h.record())?.analysisFailures?.length, 1);
});

test("条目全部校验失败（时间戳越界）的分块同样记为失败", async () => {
  const outOfRange: Reply = {
    text: JSON.stringify({ chapters: [{ title: "越界", timestampSeconds: 99999, summary: "" }], keyQuotes: [{ quote: "也越界", timestampSeconds: -5 }] }),
  };
  const h = overviewHarness({ respond: ({ user, isVerdict }) => (!isVerdict && FAIL_CHUNK(user) ? outOfRange : undefined) });
  assert.equal(value(await h.generate().result).failedChunks, 1);
});

test("每块都没有有效条目时整份报空概览，提示重试", async () => {
  const h = overviewHarness({ respond: ({ isVerdict }) => (isVerdict ? undefined : { text: "{}" }) });
  assert.equal(codeOf(await h.generate().result), "EMPTY_ANALYSIS");
});

test("有失败块时把缺失时段告诉结论模型，结论标成不完整并允许「信息不足」", async () => {
  const h = overviewHarness({
    respond: ({ user, isVerdict }) => {
      if (isVerdict) return verdictReply("只讲了前半", "信息不足");
      return FAIL_CHUNK(user) ? { text: "{}" } : undefined;
    },
  });
  const result = value(await h.generate().result);
  const [ask] = h.verdictAsks();
  assert.match(ask?.user ?? "", /覆盖：不完整/);
  assert.ok(ask?.user.includes("2:30"), ask?.user ?? "没有结论请求");
  assert.equal(result.analysis.verdict?.verdict, "信息不足");
  assert.equal(result.analysis.verdict?.incomplete, true);
  assert.equal((await h.record())?.analysis.verdict?.incomplete, true, "不完整标记随结论落库");
});

test("生成概览时用户点停止：返回已取消，不报错误", async () => {
  const started = deferred();
  const h = overviewHarness({
    respond: ({ isVerdict, request }) => {
      if (isVerdict) return undefined;
      started.resolve();
      return hang(request.signal);
    },
  });
  const { taskId, result } = h.generate();
  await started.promise;
  await stop(h, taskId);
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.deepEqual(h.logs, [], "取消不是故障，不往日志里报错");
});

test("补失败块时用户点停止：同样不报错误", async () => {
  const h = overviewHarness();
  h.setFailMode("marker");
  await h.generate().result;
  h.setFailMode(null);
  h.logs.length = 0;
  const started = deferred();
  h.setRespond(({ isVerdict, request }) => {
    if (isVerdict) return undefined;
    started.resolve();
    return hang(request.signal);
  });
  const { taskId, result } = h.retry();
  await started.promise;
  await stop(h, taskId);
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.deepEqual(h.logs, []);
});

test("真正的失败照常记错误日志", async () => {
  const h = overviewHarness();
  h.setFailMode("all");
  assert.equal(codeOf(await h.generate().result), "NO_AI_CONFIG");
  assert.equal(h.logs.filter((entry) => entry.level === "error").length, 1);
  assert.match(h.logs[0]?.text ?? "", /概览生成失败/);
});

test("别的视频占着唯一的名额时，取消的任务不必等它，立刻结束", async () => {
  const holder = deferred();
  let calls = 0;
  const h = overviewHarness({
    concurrency: 1,
    respond: () => {
      calls += 1;
      // 第一个请求属于视频 A，挂着不放，A 也不取消；之后的请求照常回复。
      return calls === 1 ? holder.promise.then(() => undefined) : undefined;
    },
  });
  const first = h.generate();
  assert.ok(await until(() => calls === 1), "视频 A 的第一个请求占着名额");
  const second = h.generate({ video: OTHER });
  const secondId = await second.taskId;
  assert.ok(await until(() => h.progress().some((task) => task.id === secondId && task.phase === "generating")), "视频 B 的分块排到了闸门外");
  let settled = false;
  void second.result.then(() => (settled = true));
  await stop(h, second.taskId);
  assert.ok(await until(() => settled), "排队中的分块要立刻响应取消");
  assert.equal(calls, 1, "B 一个请求都没发");
  assert.equal(codeOf(await second.result), "TASK_CANCELED");
  holder.resolve();
  await first.result;
});

// ============================================================
// 被截断的正文：标出来并随结果保存
// ============================================================

const TRUNCATED_CHUNK: Reply = { text: '{"chapters":[{"title":"后半","timestampSeconds":150,"summary":"讲到一半', truncated: true };

test("某一块的正文被截断：概览照常合并，并记下这一段可能不完整", async () => {
  const h = overviewHarness({ respond: ({ user, isVerdict }) => (!isVerdict && FAIL_CHUNK(user) ? TRUNCATED_CHUNK : undefined) });
  const result = value(await h.generate().result);
  assert.equal(result.failedChunks, 0, "截断不是失败：补齐后的章节照常用");
  assert.ok(titles(result).includes("后半"));
  const ranges = (result.analysis as { readonly truncatedRanges?: unknown }).truncatedRanges;
  // 区间沿用分块的起止：末块的终点是它最后一个分段的起点，这里只有一个分段。
  assert.deepEqual(ranges, [{ startSeconds: 150, endSeconds: 150 }]);
  assert.deepEqual((await h.record())?.analysis, result.analysis, "随概览落库");
});

test("没有截断时概览不带截断字段", async () => {
  const h = overviewHarness();
  assert.equal("truncatedRanges" in value(await h.generate().result).analysis, false);
});

test("补失败块时补上的那块被截断：记下它，原有的截断记录留着", async () => {
  const front: Reply = { text: '{"chapters":[{"title":"前半","timestampSeconds":0,"summary":"半', truncated: true };
  const h = overviewHarness({ respond: ({ user, isVerdict }) => (!isVerdict && !FAIL_CHUNK(user) ? front : undefined) });
  h.setFailMode("marker");
  const first = value(await h.generate().result);
  const startsOf = (analysis: unknown): unknown => ((analysis as { readonly truncatedRanges?: { readonly startSeconds: number }[] }).truncatedRanges ?? []).map((range) => range.startSeconds);
  assert.deepEqual(startsOf(first.analysis), [0]);
  h.setFailMode(null);
  h.setRespond(({ user, isVerdict }) => (!isVerdict && FAIL_CHUNK(user) ? TRUNCATED_CHUNK : undefined));
  const result = value(await h.retry().result);
  assert.deepEqual(startsOf(result.analysis), [0, 150]);
  assert.deepEqual(startsOf((await h.record())?.analysis), [0, 150]);
});

test("一句话结论的正文被截断：结论照常用，标上可能不完整", async () => {
  const h = overviewHarness({
    respond: ({ isVerdict }) => (isVerdict ? { text: '{"summary":"讲了两段","value":"有方法","verdict":"看概览就够","reason":"要点', truncated: true } : undefined),
  });
  const result = value(await h.generate().result);
  assert.equal(result.analysis.verdict?.summary, "讲了两段");
  assert.equal(result.analysis.verdict?.truncated, true);
  assert.equal((await h.record())?.analysis.verdict?.truncated, true, "截断标记随结论落库");
});

test("概览分块和一句话结论各按自己的 schema 请求结构化输出", async () => {
  const h = overviewHarness();
  value(await h.generate().result);
  const formats = h.asks.map((ask) => ask.request.responseFormat);
  assert.equal(formats.filter((format) => format === VERDICT).length, 1);
  assert.ok(formats.filter((format) => format === ANALYSIS_CHUNK).length >= 1);
  assert.equal(formats.filter((format) => format === VERDICT || format === ANALYSIS_CHUNK).length, formats.length, "没有别的格式混进来");
});

// ============================================================
// 边生成边显示：每完成一块就广播一份临时概览，只给界面看、不落库
// ============================================================

// 两块各挂一道闸门，由用例决定谁先完成。结论照常回复。
function gatedChunks() {
  const gates = { first: deferred(), second: deferred() };
  const respond = async ({ user, isVerdict, request }: { readonly user: string; readonly isVerdict: boolean; readonly request: { readonly signal?: AbortSignal | undefined } }) => {
    if (isVerdict) return undefined;
    await abortable(FAIL_CHUNK(user) ? gates.second.promise : gates.first.promise, request.signal);
    return undefined;
  };
  return { gates, respond };
}

test("长视频每完成一块就广播一份临时概览：只含已完成的块，按时间排好，不落库", async () => {
  const { gates, respond } = gatedChunks();
  const h = overviewHarness({ respond });
  const { taskId, result } = h.generate();
  // 后一块先完成：临时概览里只有它。
  gates.second.resolve();
  assert.ok(await until(() => h.previews().length > 0));
  const [first] = h.previews();
  assert.deepEqual({ taskId: first?.taskId, video: first?.video, done: first?.done, total: first?.total }, { taskId: await taskId, video: VIDEO, done: 1, total: 2 });
  assert.deepEqual(titles(first), ["章@150"]);
  assert.equal(first?.analysis.verdict, undefined, "临时概览没有结论");
  assert.equal(await h.record(), null, "临时概览不落库");
  assert.equal(h.updates().length, 0, "还没合并落库，不能说章节已保存");

  gates.first.resolve();
  const done = value(await result);
  const previews = h.previews();
  assert.equal(previews.length, 2);
  assert.equal(previews[1]?.done, 2);
  assert.deepEqual(titles(previews[1]), ["章@0", "章@150"], "合并时按时间顺序排，不按完成先后");
  assert.deepEqual(titles(done), ["章@0", "章@150"]);
  const updatedAt = h.broadcasts.findIndex((message) => message.type === "overview.updated");
  assert.ok(updatedAt > h.broadcasts.indexOf(previews[1] as (typeof h.broadcasts)[number]), "最终结果在全部临时概览之后才发");
});

test("临时概览和最终结果一样标出被截断、靠补齐读出来的块", async () => {
  const h = overviewHarness({ respond: ({ user, isVerdict }) => (!isVerdict && FAIL_CHUNK(user) ? { ...chapterReply("章@150", 150), truncated: true } : undefined) });
  const result = value(await h.generate().result);
  const last = h.previews().at(-1);
  assert.equal(h.previews().length, 2);
  const ranges = (analysis: unknown): unknown => (analysis as { readonly truncatedRanges?: unknown }).truncatedRanges;
  assert.deepEqual(ranges(last?.analysis), [{ startSeconds: 150, endSeconds: 150 }]);
  assert.deepEqual(ranges(last?.analysis), ranges(result.analysis), "和最终结果一致");
});

test("失败后自动补上的块也会更新临时概览", async () => {
  let failedOnce = false;
  const h = overviewHarness({
    respond: ({ user, isVerdict }) => {
      if (isVerdict || !FAIL_CHUNK(user) || failedOnce) return undefined;
      failedOnce = true;
      throw new Error("偶发超时");
    },
  });
  assert.equal(value(await h.generate().result).failedChunks, 0);
  assert.deepEqual(h.previews().map((message) => `${message.done}/${message.total}`), ["1/2", "2/2"]);
});

test("取消之后完成的块不再广播临时概览；已经付费的块照样保存，不写结论", async () => {
  const late = deferred();
  const h = overviewHarness({
    // 后一块在用户点停止之后才回来，而且不认取消信号（请求已经发出去了）。
    respond: async ({ user, isVerdict }) => (!isVerdict && FAIL_CHUNK(user) ? (await late.promise, undefined) : undefined),
  });
  const { taskId, result } = h.generate();
  assert.ok(await until(() => h.previews().length > 0));
  await stop(h, taskId);
  late.resolve();
  const done = value(await result);
  assert.equal(done.canceled, true);
  assert.equal(h.previews().length, 1, "停止之后不再冒出新的临时概览");
  // 停止时已经发出去的那块也是付过费的：一并存下，免得再生成时重付。
  const stored = await h.record();
  assert.deepEqual(titles(stored), ["章@0", "章@150"]);
  assert.equal(stored?.analysis.verdict, undefined, "停止后不再写结论");
  assert.equal(h.verdictAsks().length, 0);
});

test("只有一块的视频、补失败块都不发临时概览", async () => {
  // 对照：同样两块的整份生成是会发的。
  const control = overviewHarness();
  value(await control.generate().result);
  assert.equal(control.previews().length, 2);

  const single = overviewHarness({ segments: twoSegments().slice(0, 1) });
  value(await single.generate().result);
  assert.equal(single.previews().length, 0, "一块的临时概览就是最终结果，不必多发");

  const retry = overviewHarness();
  retry.setFailMode("marker");
  await retry.generate().result;
  retry.setFailMode(null);
  const before = retry.previews().length;
  value(await retry.retry().result);
  assert.equal(retry.previews().length, before);
});

test("临时概览广播出错不影响生成", async () => {
  const h = overviewHarness();
  const original = h.broadcasts.push.bind(h.broadcasts);
  let attempts = 0;
  h.broadcasts.push = (...messages) => {
    if (messages.some((message) => message.type === "overview.preview")) {
      attempts += 1;
      throw new Error("面板关着");
    }
    return original(...messages);
  };
  const result = value(await h.generate().result);
  assert.equal(attempts, 2, "每块完成都试着广播了");
  assert.equal(result.failedChunks, 0, "广播失败不能把块算成失败");
});

test("生成概览时换了字幕语言：概览照常写进去，缓存里换过的字幕不被旧快照盖掉", async () => {
  const transcript = transcriptHarness();
  let switched = false;
  const h = overviewHarness({
    transcript: transcript.service,
    respond: async ({ isVerdict }) => {
      if (isVerdict || switched) return undefined;
      switched = true;
      // 第一个模型请求在途时侧边栏换到了英文轨，缓存里随之换成英文字幕。
      assert.ok((await transcript.service.get(TRANSCRIPT_REF, { mode: "full", lang: "en-US" })).ok);
      return undefined;
    },
  });
  const result = value(await h.service.generate(await h.register(TRANSCRIPT_KEY), TRANSCRIPT_KEY, { fresh: true }));
  assert.ok(result.analysis.chapters?.length, "概览按视频算，照常写入");
  const [row] = await transcript.rows();
  assert.equal(row?.transcript?.ref.lang, "en-US");
  const basis = (await h.record(TRANSCRIPT_KEY))?.parts?.chapters?.derived.basis;
  assert.equal(basis?.source === "transcript" && basis.transcript.lang, "zh-CN", "概览记下依据的是生成时那份中文字幕");
});

test("分块请求遇到限流或过载、要等一会儿再重发时，等待提示写进概览任务的进度", async () => {
  const h = overviewHarness({
    respond: ({ isVerdict, user, request }) => {
      if (isVerdict || !FAIL_CHUNK(user)) return undefined;
      request.onRetry?.({ status: 429, delayMs: 4000, message: "服务限流，4 秒后重试…" });
      return undefined;
    },
  });
  const { taskId, result } = h.generate();
  value(await result);
  const id = await taskId;
  assert.ok(h.progress().some((task) => task.id === id && task.message === "服务限流，4 秒后重试…"));
});

// ============================================================
// 自动补轮只补可能是偶发的失败（确定性失败重跑只会再付一遍钱）
// ============================================================

function failingChunk(makeError: () => Error, times = Infinity) {
  let calls = 0;
  const h = overviewHarness({
    respond: ({ user, isVerdict }) => {
      if (isVerdict || !FAIL_CHUNK(user)) return undefined;
      calls += 1;
      if (calls <= times) throw makeError();
      return undefined;
    },
  });
  return { h, calls: () => calls };
}

const coded = (message: string, fields: Record<string, unknown>): Error => Object.assign(new Error(message), fields);

const DETERMINISTIC: readonly [string, () => Error][] = [
  ["思考把预算用光（传输层已经加码到顶）", () => coded("还是不够", { code: "EMPTY_AI_RESPONSE", reason: "TRUNCATED" })],
  ["拒绝回答", () => coded("拒绝", { code: "AI_REFUSED" })],
  ["硬超时", () => coded("超时", { code: "AI_HARD_TIMEOUT" })],
  ["响应超过大小上限", () => coded("太大", { code: "AI_RESPONSE_TOO_LARGE" })],
  ["HTTP 400", () => coded("bad request", { status: 400 })],
  // 下面几种传输层特意不重发，补轮也不该替它重发。
  ["额度用完的 429", () => coded("quota", { status: 429, quotaExhausted: true, noAutoRetry: true })],
  ["Retry-After 超过 20 秒的 429", () => coded("slow down", { status: 429, retryAfterMs: 60_000, noAutoRetry: true })],
  ["中转站说没有这个模型的 503", () => coded("无可用渠道", { status: 503, noAutoRetry: true })],
];

for (const [label, makeError] of DETERMINISTIC) {
  test(`确定性失败（${label}）不自动补轮：这一块只发一次`, async () => {
    const { h, calls } = failingChunk(makeError);
    const result = value(await h.generate().result);
    assert.equal(result.failedChunks, 1);
    assert.equal(calls(), 1);
  });
}

test("可能是偶发的失败（限流、过载、空闲超时、解析失败）照常自动补一轮", async () => {
  for (const makeError of [
    () => coded("限流", { status: 429 }),
    () => coded("过载", { status: 529 }),
    () => coded("断流", { code: "AI_IDLE_TIMEOUT" }),
    () => coded("连不上", { code: "AI_NETWORK_ERROR" }),
    () => coded("读不出", { code: "AI_RESPONSE_TRUNCATED" }),
  ]) {
    const { h, calls } = failingChunk(makeError, 1);
    assert.equal(value(await h.generate().result).failedChunks, 0, makeError().message);
    assert.equal(calls(), 2, makeError().message);
  }
});

test("点「补失败块」遇到确定性失败：一次点击只发一次", async () => {
  const { h, calls } = failingChunk(() => coded("还是不够", { code: "EMPTY_AI_RESPONSE", reason: "TRUNCATED" }));
  await h.generate().result;
  const before = calls();
  assert.equal(value(await h.retry().result).failedChunks, 1);
  assert.equal(calls() - before, 1);
});

test("传输层自己重发过、回来的还是读不出的 JSON：这块不再自动补一轮", async () => {
  let failed = 0;
  const h = overviewHarness({
    segments: threeSegments(),
    respond: ({ user, isVerdict }) => {
      if (isVerdict || !user.includes("FAIL标记一")) return undefined;
      failed += 1;
      return { text: "不是 JSON", sends: 2 };
    },
  });
  await h.generate().result;
  assert.equal(failed, 1, "这一块已经发过两次，补轮不再发");
});

test("传输层自己重发过、回来的是合法但空的 JSON（EMPTY_CHUNK）：这块不再自动补一轮", async () => {
  let failed = 0;
  const h = overviewHarness({
    segments: threeSegments(),
    respond: ({ user, isVerdict }) => {
      if (isVerdict || !user.includes("FAIL标记一")) return undefined;
      failed += 1;
      return { text: "{}", sends: 2 };
    },
  });
  await h.generate().result;
  assert.equal(failed, 1);
});

test("只发过一次就回空 JSON（EMPTY_CHUNK）的块照常补一轮", async () => {
  let failed = 0;
  const h = overviewHarness({
    segments: threeSegments(),
    respond: ({ user, isVerdict }) => {
      if (isVerdict || !user.includes("FAIL标记一")) return undefined;
      failed += 1;
      return failed === 1 ? { text: "{}", sends: 1 } : undefined;
    },
  });
  await h.generate().result;
  assert.equal(failed, 2);
});

test("自动补轮里的那一次不让传输层再自己重发（selfRetry: false），一块最多发两次", async () => {
  const seen: unknown[] = [];
  const h = overviewHarness({
    segments: threeSegments(),
    respond: ({ user, isVerdict, request }) => {
      if (isVerdict || !user.includes("FAIL标记一")) return undefined;
      seen.push(request.selfRetry);
      if (seen.length === 1) throw coded("HTTP 500", { status: 500 });
      return undefined;
    },
  });
  await h.generate().result;
  assert.deepEqual(seen, [true, false], "首轮照常，补轮那一次不再自己重发");
});

// ============================================================
// 停止生成时保住已经付费完成的分块；清除本机数据后不写回
// ============================================================

const hangFailChunks = ({ user, isVerdict, request }: { readonly user: string; readonly isVerdict: boolean; readonly request: { readonly signal?: AbortSignal | undefined } }) =>
  isVerdict || !FAIL_CHUNK(user) ? undefined : hang(request.signal);

test("生成到一半点停止：已完成的块落库，被停掉的块记成失败块，跳过结论", async () => {
  const h = overviewHarness({ respond: hangFailChunks });
  const { taskId, result } = h.generate();
  assert.ok(await until(() => h.previews().length === 1));
  await stop(h, taskId);
  const done = value(await result);
  assert.equal(done.canceled, true);
  assert.equal(done.savedChunks, 1);
  assert.equal(done.failedChunks, 1);
  assert.deepEqual(titles(done), ["章@0"]);
  assert.equal(h.verdictAsks().length, 0, "停止后不再写结论");
  const stored = await h.record();
  assert.deepEqual(titles(stored), ["章@0"]);
  assert.deepEqual(stored?.analysisFailures?.map((failure) => failure.index), [1]);
  assert.deepEqual(h.logs, [], "停止不是故障");

  // 之后「补失败块」只补被停掉的那一块。
  h.setRespond(undefined);
  const before = h.chunkAsks().length;
  const retried = value(await h.retry().result);
  assert.equal(retried.failedChunks, 0);
  assert.equal(h.chunkAsks().length - before, 1);
  assert.deepEqual(titles(retried), ["章@0", "章@150"]);
});

test("因为「清除本机数据」被取消：已完成的块也不落库，不把刚清掉的数据写回去", async () => {
  const h = overviewHarness({ respond: hangFailChunks });
  const { taskId, result } = h.generate();
  assert.ok(await until(() => h.previews().length === 1));
  // 清除本机数据时在途任务按「数据已清除」取消。
  await stop(h, taskId, { code: "LOCAL_DATA_CLEARED" });
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(await h.record(), null, "概览不被写回");
});

test("先点停止、收尾还没存完时清除了本机数据：已完成的块也不写回", async () => {
  const h = overviewHarness({ respond: hangFailChunks });
  const { taskId, result } = h.generate();
  assert.ok(await until(() => h.previews().length === 1));
  await stop(h, taskId); // 普通的「停止生成」，不带清除原因
  // 收尾还没写之前，设置页清除了本机数据。
  const clearing = h.guard.clear("all", async () => {});
  assert.equal(codeOf(await result), "TASK_CANCELED");
  await clearing;
  assert.equal(await h.record(), null, "概览不被写回");
});

test("概览进了写队列、还没写时清除了本机数据：概览不被重建", async () => {
  let queued!: () => void;
  const reached = new Promise<void>((resolve) => (queued = resolve));
  const h = overviewHarness({
    wrapStore: (inner) => ({
      ...inner,
      updateRecord(key, plan, options) {
        const writing = inner.updateRecord(key, plan, options);
        if (key === VIDEO) queued();
        return writing;
      },
    }),
  });
  // 前面占着写队列的一项，放行前概览的保存只能排队等着。
  const ahead = deferred();
  const blocker = h.store.updateRecord(OTHER, async () => {
    await ahead.promise;
    return {};
  });
  const { result } = h.generate();
  await reached;
  // 排在写队列里的这段时间，设置页清除了本机数据。
  const clearing = h.guard.clear("all", async () => {});
  ahead.resolve();
  await blocker;
  await clearing;
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(await h.record(), null);
});

test("一块都没完成就停止：照旧报已取消，什么也不存", async () => {
  const started = deferred();
  const h = overviewHarness({
    respond: ({ isVerdict, request }) => {
      if (isVerdict) return undefined;
      started.resolve();
      return hang(request.signal);
    },
  });
  const { taskId, result } = h.generate();
  await started.promise;
  await stop(h, taskId);
  assert.equal(codeOf(await result), "TASK_CANCELED");
  assert.equal(await h.record(), null);
});

// ============================================================
// 重新生成已有的概览：先写草稿，结论写好才换上
// ============================================================

const OLD: OverviewRecord = record(
  { chapters: [{ title: "旧概览", timestampSeconds: 0 }], keyQuotes: [], verdict: { summary: "旧结论", verdict: "可以跳过" } },
  { analysisFailures: [{ index: 3, startSeconds: 450, endSeconds: 600 }] },
);

/** 生效的章节、结论和失败区间：重新生成没写完时这几样都不能变。 */
const effective = (stored: OverviewRecord | null) => ({ analysis: stored?.analysis, analysisFailures: stored?.analysisFailures });

test("重新生成已有的概览时停止：不拿残缺的结果覆盖原来那份", async () => {
  // 停在分块这一步：残缺的结果什么也不存。
  const chunkStage = overviewHarness({ records: [OLD], respond: hangFailChunks });
  const chunking = chunkStage.generate({ fresh: true });
  assert.ok(await until(() => chunkStage.previews().length === 1));
  await stop(chunkStage, chunking.taskId);
  assert.equal(codeOf(await chunking.result), "TASK_CANCELED");
  assert.deepEqual(effective(await chunkStage.record()), effective(OLD));
  assert.equal((await chunkStage.record())?.draft, undefined);

  // 停在写结论这一步：分块都写完了，生效的那份照样不动，新章节留在草稿里。
  const started = deferred();
  const verdictStage = overviewHarness({
    records: [OLD],
    respond: ({ isVerdict, request }) => {
      if (!isVerdict) return undefined;
      started.resolve();
      return hang(request.signal);
    },
  });
  const concluding = verdictStage.generate({ fresh: true });
  await started.promise;
  await stop(verdictStage, concluding.taskId);
  const done = value(await concluding.result);
  assert.equal(done.verdictCanceled, true);
  assert.equal(done.draftKept, true);
  assert.deepEqual(titles(done), ["旧概览"], "交回的是生效中的那份");
  const stored = await verdictStage.record();
  assert.deepEqual(effective(stored), effective(OLD));
  assert.deepEqual(titles(stored?.draft), ["章@0", "章@150"]);
  assert.equal(verdictStage.updates().length, 0, "生效的那份没变，不通知页面");
});

test("重新生成时结论没写成：生效的章节、结论和失败区间都不变，新章节留在草稿里", async () => {
  const h = overviewHarness({ records: [OLD], respond: ({ isVerdict }) => (isVerdict ? { text: "不是 JSON" } : undefined) });
  const done = value(await h.generate({ fresh: true }).result);
  assert.equal(done.draftKept, true);
  assert.equal(done.verdictCanceled, undefined);
  const stored = await h.record();
  assert.deepEqual(effective(stored), effective(OLD));
  assert.deepEqual(titles(stored?.draft), ["章@0", "章@150"]);
  assert.equal(stored?.draft?.chapters.taskCreatedAt, START);
});

test("重新生成写好结论：草稿连同结论一起换上，章节和结论各记下这次的依据和生成配置", async () => {
  const h = overviewHarness({ records: [OLD], respond: ({ isVerdict }) => (isVerdict ? verdictReply("新结论") : undefined) });
  const done = value(await h.generate({ fresh: true }).result);
  assert.deepEqual(titles(done), ["章@0", "章@150"]);
  assert.equal(done.analysis.verdict?.summary, "新结论");
  const stored = await h.record();
  assert.equal(stored?.draft, undefined, "草稿换上以后就没了");
  assert.deepEqual(titles(stored), ["章@0", "章@150"]);
  assert.equal(stored?.analysis.verdict?.summary, "新结论");
  assert.equal(stored?.analysisFailures, undefined, "失败区间换成这次的");
  assert.equal(stored?.parts?.chapters?.derived.gen?.model, "chunk-model");
  assert.equal(stored?.parts?.verdict?.derived.gen?.model, "verdict-model", "结论那一步用登记时取定的结论模型");
  assert.equal(stored?.parts?.verdict?.taskCreatedAt, START);
  assert.deepEqual(h.updates().map((message) => message.verdictPending), [false]);
});

test("重新生成只得到金句、没有章节：照样写结论，草稿换上，这次付过费的金句看得到", async () => {
  const quoteOnly = { text: JSON.stringify({ chapters: [], keyQuotes: [{ quote: "新的金句", timestampSeconds: 5 }] }) };
  const h = overviewHarness({ records: [OLD], respond: ({ isVerdict }) => (isVerdict ? verdictReply("只看金句写的结论") : quoteOnly) });
  const done = value(await h.generate({ fresh: true }).result);
  assert.equal(h.verdictAsks().length, 1, "写了结论");
  assert.equal(done.analysis.verdict?.summary, "只看金句写的结论");
  const stored = await h.record();
  assert.equal(stored?.draft, undefined, "草稿换上了");
  assert.deepEqual(stored?.analysis.keyQuotes?.map((quote) => quote.quote), ["新的金句"]);
  assert.deepEqual(stored?.analysis.chapters ?? [], []);
});

test("补失败块补到一半点停止：补上的块并进概览保存，剩下的仍是失败块，不重写结论", async () => {
  const h = overviewHarness({ segments: threeSegments() });
  h.setFailMode("marker");
  await h.generate().result;
  h.setFailMode(null);
  const verdictsBefore = h.verdictAsks().length;
  const firstDone = deferred();
  h.setRespond(({ user, isVerdict, request }) => {
    if (isVerdict || !user.includes("FAIL标记二")) return undefined;
    return firstDone.promise.then(() => hang(request.signal));
  });
  const { taskId, result } = h.retry();
  const id = await taskId;
  assert.ok(await until(() => h.progress().some((task) => task.id === id && task.done === 1)));
  firstDone.resolve();
  await stop(h, taskId);
  const done = value(await result);
  assert.equal(done.canceled, true);
  assert.equal(done.savedChunks, 1);
  assert.equal(done.failedChunks, 1);
  assert.deepEqual(titles(done), ["章@0", "章@150"]);
  assert.equal(h.verdictAsks().length, verdictsBefore, "停止后不重写结论");
  assert.deepEqual((await h.record())?.analysisFailures?.map((failure) => failure.index), [2]);
});

test("进度只走任务中心，不另发进度广播", async () => {
  const h = overviewHarness();
  const { taskId, result } = h.generate();
  value(await result);
  const id = await taskId;
  assert.ok(h.progress().filter((task) => task.id === id).length >= 3, "每个进度点都报给了任务中心");
  assert.deepEqual([...new Set(h.broadcasts.map((message) => message.type))].sort(), ["overview.preview", "overview.updated", "task.changed"]);
});

test("部分概览分块失败会保存失败区间，补失败块只请求失败段", async () => {
  let failSecond = true;
  const requested: string[] = [];
  const h = overviewHarness({
    respond: ({ user, isVerdict }) => {
      if (isVerdict) return verdictReply(failSecond ? "讲了前半" : "讲了前半和后半");
      requested.push(FAIL_CHUNK(user) ? "后半" : "前半");
      if (FAIL_CHUNK(user) && failSecond) throw new Error("第二块失败");
      return undefined;
    },
  });
  const first = value(await h.generate().result);
  assert.equal(first.failedChunks, 1);
  assert.deepEqual(titles(first), ["章@0"]);
  assert.equal(first.analysis.verdict?.verdict, "看概览就够", "合并后附上一句话结论");
  assert.ok((first.analysisFailures[0]?.startSeconds ?? 0) > 0);
  assert.equal((await h.record())?.analysisFailures?.length, 1);

  failSecond = false;
  requested.length = 0;
  const retried = value(await h.retry().result);
  assert.deepEqual(requested, ["后半"], "补失败块只打失败段");
  assert.deepEqual(titles(retried), ["章@0", "章@150"]);
  assert.equal(retried.failedChunks, 0);
  assert.equal(retried.analysis.verdict?.summary, "讲了前半和后半", "补齐后按完整内容重写结论");
  const stored = await h.record();
  assert.equal(stored?.analysisFailures, undefined);
  assert.equal(stored?.analysis.verdict?.verdict, "看概览就够", "结论随概览一起落库");
});

test("一句话结论生成失败时，概览照常返回，只是没有结论", async () => {
  const h = overviewHarness({
    segments: twoSegments().slice(0, 1),
    respond: ({ isVerdict }) => {
      if (isVerdict) throw new Error("结论请求失败");
      return undefined;
    },
  });
  const result = value(await h.generate().result);
  assert.equal(result.analysis.chapters?.length, 1);
  assert.equal(result.analysis.verdict, undefined);
});

// ============================================================
// 分块都付过费，存不下也照样交回
// ============================================================

/** 前 times 次写概览都报空间不足。 */
function failingSaves(times: number) {
  let left = times;
  return (inner: ObjectStoreDriver<OverviewRecord>): ObjectStoreDriver<OverviewRecord> => ({
    ...inner,
    async write(change = {}) {
      if ((change.put?.length ?? 0) > 0 && left > 0) {
        left -= 1;
        throw Object.assign(new Error("QuotaExceededError: The quota has been exceeded."), { name: "QuotaExceededError" });
      }
      return inner.write(change);
    },
  });
}

const withVerdict = ({ isVerdict }: { readonly isVerdict: boolean }) => (isVerdict ? verdictReply() : undefined);

test("分块都付过费、长期保存失败：照样交回概览和结论，标明没存上", async () => {
  const h = overviewHarness({ wrapDriver: failingSaves(Infinity), respond: withVerdict });
  const result = value(await h.generate().result);
  assert.equal(h.asks.length, 3, "两块加一次结论都发出去了");
  assert.deepEqual(titles(result), ["章@0", "章@150"]);
  assert.equal(result.analysis.verdict?.summary, "讲了两段");
  assert.equal(result.saveFailed, true);
  assert.equal(await h.record(), null);
});

test("章节那次没存上、补存结论那次存上了：最终存下了，不报保存失败", async () => {
  const h = overviewHarness({ wrapDriver: failingSaves(1), respond: withVerdict });
  const result = value(await h.generate().result);
  assert.equal(result.saveFailed, undefined);
  const stored = await h.record();
  assert.deepEqual(titles(stored), ["章@0", "章@150"], "补存结论时连章节一起存上了");
  assert.equal(stored?.analysis.verdict?.summary, "讲了两段");
});

test("保存都成功时不带 saveFailed", async () => {
  const h = overviewHarness({ respond: withVerdict });
  assert.equal("saveFailed" in value(await h.generate().result), false);
});

test("补失败块也一样：补上的块付过费，存不下也交回，标明没存上", async () => {
  const h = overviewHarness({
    wrapDriver: failingSaves(Infinity),
    respond: withVerdict,
    records: [record({ chapters: [{ title: "章@0", timestampSeconds: 0, summary: "s" }], keyQuotes: [] }, { analysisFailures: [{ index: 1, startSeconds: 150, endSeconds: 600, reason: "超时" }] })],
  });
  const result = value(await h.retry().result);
  assert.deepEqual(titles(result), ["章@0", "章@150"]);
  assert.equal(result.failedChunks, 0);
  assert.equal(result.saveFailed, true);
});

// ============================================================
// 走真实的后台分发：保活、密钥不外露
// ============================================================

const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model", analysisChunkMode: "short" };
const GATEWAY_ORIGIN = "https://gateway.example.com/";
const readPrompt = (file: string): string => readFileSync(new URL(`../../../../../prompts/${file}`, import.meta.url), "utf8").replaceAll("\r", "");
const PROMPT_FILES = { "analysis.md": readPrompt("analysis.md"), "verdict.md": readPrompt("verdict.md") };
const userOf = (request: SentRequest): string => {
  const messages = (request.body?.messages ?? []) as { readonly role: string; readonly content: string }[];
  return messages.find((message) => message.role === "user")?.content ?? "";
};
const isVerdictRequest = (request: SentRequest): boolean => userOf(request).includes("章节摘要");
/** 按概览提示词里写的本块起点回一章。 */
const chunkAnswer = (request: SentRequest, title = "开场") => {
  const seconds = Number(/（第 (\d+) 秒）/.exec(userOf(request))?.[1] ?? 0);
  return chatReply(JSON.stringify({ chapters: [{ title, timestampSeconds: seconds, summary: "摘要" }], keyQuotes: [] }));
};
const VERDICT_ANSWER = chatReply(JSON.stringify({ summary: "结论", value: "", verdict: "信息不足", reason: "测试" }));

function background(handler: (request: SentRequest) => ReturnType<typeof chatReply> | Promise<ReturnType<typeof chatReply>>, cues?: Cue[]) {
  const ai = modelService(handler);
  const site = fakeSiteService(cues ? { captions: () => ({ ok: true, value: cues }) } : {});
  const storage = keyedStorage(GATEWAY, GATEWAY_ORIGIN);
  const fake = createFakeChrome({ ...storage, grantedOrigins: [GATEWAY_ORIGIN], fetch: ai.fetch, prompts: PROMPT_FILES, site: site.service });
  // 后台日志截下来，看里面有没有密钥。
  const logged: unknown[][] = [];
  const app = createApp(fake.deps({ warn: (...args: unknown[]) => void logged.push(args), error: (...args: unknown[]) => void logged.push(args) }));
  async function generate() {
    const started = await app.dispatch({ type: "task.start", req: { kind: "overview", video: TRANSCRIPT_KEY } }, senders.panel());
    assert.ok(started.ok, JSON.stringify(started));
    const { task } = started.value as { readonly task: { readonly id: string } };
    return app.dispatch({ type: "overview.start", req: { video: TRANSCRIPT_KEY, taskId: task.id } }, senders.panel());
  }
  return { ai, fake, app, generate, logged };
}

test("概览请求挂着时每 20 秒保活一次；回来后照常落库，保活随即停下", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const bg = background(async (request) => (isVerdictRequest(request) ? VERDICT_ANSWER : (await gate.promise, chunkAnswer(request))));
  const pending = bg.generate();
  assert.ok(await until(() => bg.ai.posts().length === 1), "模型请求发出去了");
  assert.equal(bg.fake.timers.due(INTERVAL), 1, "任务进行中排着下一次保活");
  assert.equal(bg.fake.calls.pings, 0, "不到 20 秒不调");
  bg.fake.timers.fire(INTERVAL);
  bg.fake.timers.fire(INTERVAL);
  assert.equal(bg.fake.calls.pings, 2);

  gate.resolve();
  const result = await pending;
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(bg.fake.timers.due(INTERVAL), 0, "任务结束就停，不拖着 worker");
  const stored = await bg.app.dispatch({ type: "overview.get", req: { video: TRANSCRIPT_KEY } }, senders.panel());
  assert.ok(stored.ok);
  assert.equal(titles((stored.value as { readonly overview?: { readonly analysis: OverviewRecord["analysis"] } }).overview)[0], "开场", "概览存进了本机");
  const listed = await bg.app.dispatch({ type: "task.list", req: {} }, senders.panel());
  assert.deepEqual(listed.ok && listed.value, { tasks: [] });
});

// 上限按推理档位的硬超时算：关档是 120 秒 × 5 轮（3 轮自愈、1 轮参数放宽、1 轮限流过载后的重发）+ 60 秒余量 = 11 分钟。
test("任务挂过 5 分钟仍在保活，到按推理档位算的截止时间才停（关档 11 分钟）", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const bg = background(async (request) => (isVerdictRequest(request) ? VERDICT_ANSWER : (await gate.promise, chunkAnswer(request))));
  const pending = bg.generate();
  assert.ok(await until(() => bg.ai.posts().length === 1));

  bg.fake.timers.advance(6 * 60_000);
  const atSix = bg.fake.calls.pings;
  assert.ok(atSix > 0, "6 分钟时还在保活（挂着的消息约 5 分钟后就不再撑着 worker）");
  bg.fake.timers.advance(4 * 60_000 + 50_000);
  const atTenFifty = bg.fake.calls.pings;
  assert.ok(atTenFifty > atSix, "10 分 50 秒时还在");
  bg.fake.timers.advance(40_000);
  assert.equal(bg.fake.calls.pings, atTenFifty, "过了 11 分钟不再续");
  assert.equal(bg.fake.timers.due(INTERVAL), 0);

  gate.resolve();
  assert.ok((await pending).ok);
});

test("概览分块失败的原因里回显了密钥：给页面的结果和存下的失败记录都不含密钥", async () => {
  const cues: Cue[] = [
    { start: 0, duration: 120, text: `正常内容。${"字".repeat(1800)}` },
    { start: 150, duration: 120, text: `FAIL标记。${"字".repeat(1800)}` },
  ];
  const bg = background((request) => {
    if (isVerdictRequest(request)) return VERDICT_ANSWER;
    if (userOf(request).includes("FAIL标记")) return reply({ error: { message: `Gateway error, rejected credential: ${SAMPLE_KEY}` } }, 400);
    return chunkAnswer(request, "章节");
  }, cues);
  const result = await bg.generate();
  assert.ok(result.ok, JSON.stringify(result));
  const done = result.value as { readonly failedChunks: number; readonly analysisFailures: readonly { readonly reason?: string }[] };
  assert.equal(done.failedChunks, 1);
  assert.match(done.analysisFailures[0]?.reason ?? "", /\[已隐藏的密钥\]/);
  assert.ok(!JSON.stringify(result).includes(SAMPLE_KEY), "给页面的结果不能含密钥");
  const stored = await bg.app.dispatch({ type: "overview.get", req: { video: TRANSCRIPT_KEY } }, senders.panel());
  assert.ok(stored.ok);
  assert.ok(!JSON.stringify(stored).includes(SAMPLE_KEY), "存下的失败记录不能含密钥");
  assert.equal((stored.value as { readonly overview?: { readonly analysisFailures: readonly unknown[] } }).overview?.analysisFailures.length, 1);
  assert.ok(!JSON.stringify(bg.logged).includes(SAMPLE_KEY), "后台日志里也没有密钥");
});
