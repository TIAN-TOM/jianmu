// 批次服务：稍后再看粗筛的读列表、两步批次，和本窗口全部生成的清点、逐个生成、全部停止、单条重来、重开接上。
// 任务运行器、概览和写结论服务、概览仓储是真的（测试架子），站点读取和字幕是替身，计时器手动推进。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBatchService, type BatchListener } from "../../../../src/background/services/batch/index.ts";
import { titleOfTab } from "../../../../src/background/services/batch/window.ts";
import type { TranscriptService } from "../../../../src/background/services/transcript/index.ts";
import { createTriageStore } from "../../../../src/background/stores/triage.ts";
import { fail, ok } from "../../../../src/core/errors.ts";
import type { FrozenGen } from "../../../../src/core/tasks.ts";
import { STORAGE_KEY } from "../../../../src/core/triage/state.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../../../src/core/video-ref.ts";
import type { BatchOut, WindowEntryStatus } from "../../../../src/shared/messages/batch.ts";
import type { TranscriptReply } from "../../../../src/shared/messages/transcript.ts";
import { bilibiliRules } from "../../../../src/sites/bilibili/url.ts";
import type { OfficialSummary, SiteResult, WatchLaterItem } from "../../../../src/sites/types.ts";
import { failed, fakeSiteService, type FakeSiteService } from "../../../helpers/fake-site-service.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";
import { ANALYSIS_GEN, hang, overviewHarness, VERDICT_GEN, verdictReply, type OverviewHarness, type Respond } from "../../../helpers/overview-service.ts";
import { until } from "../../../helpers/wait-until.ts";

const ids = ["BV1Sample101", "BV1Sample102", "BV1Sample103", "BV1Sample104"] as const;
const refOf = (id: string, segment = 1): VideoRef => ({ platform: "bilibili", videoId: id, segment });
const keyOf = (id: string, segment = 1): VideoKey => videoKey(refOf(id, segment));

/** 列表项的观看进度：一个别处不会出现的秒数，看它有没有进写结论的材料和请求。 */
const PROGRESS = 4321;

function listItem(id: string, extra: Partial<WatchLaterItem> = {}): WatchLaterItem {
  return {
    videoKey: keyOf(id),
    title: `稍后再看 ${id}`,
    ownerName: "样例作者",
    channel: { platform: "bilibili", channelId: "3003" },
    mediaVersion: `${id}-m1`,
    duration: 300,
    progress: PROGRESS,
    finished: true,
    pageCount: 1,
    available: true,
    cover: "",
    description: "样例简介",
    addedAt: 1,
    paidChecked: true,
    ...extra,
  };
}

const officialOk = (): SiteResult<OfficialSummary> => ({ ok: true, value: { status: "ok", summary: "官方摘要", outline: [], cues: [] } });

interface Options {
  readonly site?: FakeSiteService;
  readonly respond?: Respond;
  /** 本窗口全部生成读字幕：按视频回失败码，没写的读成功。 */
  readonly ensureFails?: Readonly<Record<string, string>>;
  readonly tabs?: readonly { readonly url: string; readonly title: string }[];
  readonly verdictConcurrency?: number;
  /** 取定配置前先等它：测试在这段等待里点停止。 */
  readonly freezeGate?: Promise<void>;
  /** 登记任务前先等它：测试在登记还没回来时停下这一轮。 */
  readonly registerGate?: Promise<void>;
}

/** 一句话的字幕：概览一块就做完。 */
function transcriptView(ref: VideoRef) {
  return {
    video: videoKey(ref),
    info: { title: "测试视频", author: "UP 主", description: "简介", durationSec: 600 },
    transcript: {
      ref: { video: videoKey(ref), kind: "human" as const, lang: "zh-CN", fingerprint: `fp-${ref.videoId}` },
      trackId: "zh-CN",
      label: "中文",
      cues: [],
      segments: [{ id: "s0", start: 0, text: "正常内容。", texts: ["正常内容。"] }],
    },
    tracks: [],
    chapters: [],
    fromCache: true,
  };
}

function setup(options: Options = {}) {
  const site = options.site ?? fakeSiteService();
  const ensured: VideoKey[] = [];
  const cacheReads: VideoKey[] = [];
  // 本机字幕缓存里什么都没有：写结论只能用粗筛存的官方总结。
  const transcript: Pick<TranscriptService, "ensure" | "get"> = {
    async ensure(ref) {
      ensured.push(videoKey(ref));
      const code = options.ensureFails?.[ref.videoId];
      if (code) return fail(code as never);
      return ok({ view: transcriptView(ref), generation: 0 });
    },
    async get(ref): Promise<TranscriptReply> {
      cacheReads.push(videoKey(ref));
      return fail("NOT_CACHED");
    },
  };
  const harness: OverviewHarness = overviewHarness({ transcript, ...(options.respond ? { respond: options.respond } : {}) });
  const storage = memoryStorage();
  /** 写结论时交给结论服务的取材料函数。 */
  const materials: ((ref: VideoRef) => Promise<TranscriptReply>)[] = [];
  const timers = harness.timers;
  const gens: Record<string, FrozenGen> = { analysis: ANALYSIS_GEN, verdict: VERDICT_GEN };
  let ready = true;
  let idCount = 0;
  const tabs = options.tabs ?? [];
  const service = createBatchService({
    triage: createTriageStore({ storage, guard: harness.guard, now: timers.now }),
    sites: { service: (platform) => (platform === "bilibili" ? site.service : undefined), ctx: (_platform, { signal }) => ({ fetch, signal, backoff: { admit: async () => ({ ok: true }), trip: async () => {}, clear: async () => {} } }) },
    rules: [bilibiliRules],
    windowTabs: async () => tabs.map((tab, index) => ({ tabId: index + 1, ...tab })),
    transcript,
    overviews: harness.store,
    overview: harness.service,
    tasks: {
      ...harness.tasks,
      async register(...args: Parameters<typeof harness.tasks.register>) {
        await options.registerGate;
        return harness.tasks.register(...args);
      },
    },
    verdict: {
      fromOfficial(taskId, video, verdictOptions) {
        if (verdictOptions?.read) materials.push(verdictOptions.read);
        return harness.verdict.fromOfficial(taskId, video, verdictOptions);
      },
    },
    ai: {
      configCheck: async () => ({ ready, errors: [] }),
      async freeze(feature) {
        await options.freezeGate;
        return gens[feature] ?? ANALYSIS_GEN;
      },
    },
    guard: harness.guard,
    keepAlive: { hold: () => () => {}, during: async (_ms, work) => work() },
    timers,
    ...(options.verdictConcurrency ? { concurrency: options.verdictConcurrency } : {}),
    newId: () => `run-${(idCount += 1)}`,
    log: { warn() {}, error() {} },
  });
  const page = (id: string) => {
    const events: BatchOut[] = [];
    const listener: BatchListener = { id, post: (event) => void events.push(structuredClone(event)) };
    return { listener, events, last: <T extends BatchOut["type"]>(type: T) => events.filter((event): event is Extract<BatchOut, { type: T }> => event.type === type).at(-1) };
  };
  return { site, harness, service, storage, timers, ensured, cacheReads, materials, page, setReady: (value: boolean) => void (ready = value) };
}

/** 等到间隔计时器排上，再让它到点。 */
async function tick(timers: OverviewHarness["timers"]): Promise<void> {
  assert.ok(await until(() => timers.due(1500) > 0), "应该排上 1.5 秒的间隔");
  timers.fire(1500);
}

// 粗筛

test("读列表：只读一次稍后再看，只收第 1 P，存进本机；之后读状态不再问平台", async () => {
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 3, dropped: 1, items: [listItem(ids[0]), listItem(ids[1]), { ...listItem(ids[2]), videoKey: keyOf(ids[2], 2) }] } }),
  });
  const { service, storage, page } = setup({ site });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  const done = tab.last("triage.done");
  assert.equal(done?.step, "list");
  assert.equal(done?.dropped, 2);
  assert.deepEqual(done?.state?.list?.items.map((item) => item.videoKey), [keyOf(ids[0]), keyOf(ids[1])]);
  assert.ok(storage.data[STORAGE_KEY]);
  const state = await service.state();
  assert.equal(state.list?.items.length, 2);
  assert.equal(site.count("readWatchLater"), 1);
});

test("第一步：逐个取官方总结，两项之间隔 1.5 秒；已有定论的不再问；观看进度不进请求", async () => {
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 3, dropped: 0, items: [listItem(ids[0]), listItem(ids[1]), listItem(ids[2], { paidChecked: false })] } }),
    officialSummary: officialOk,
  });
  const { service, timers, page } = setup({ site });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  const running = service.handle({ type: "triage.start", step: "official" }, tab.listener);
  assert.ok(await until(() => site.count("readOfficialSummary") === 1));
  assert.equal(site.count("readVideoInfo"), 0, "列表里确认过付费状态、带媒体版本的，不再读视频信息");
  await tick(timers);
  assert.ok(await until(() => site.count("readOfficialSummary") === 2));
  await tick(timers);
  await running;
  assert.equal(site.count("readOfficialSummary"), 3);
  assert.equal(site.count("readVideoInfo"), 1, "没确认过付费状态的先读一次视频信息");
  assert.equal(tab.last("triage.done")?.done, 3);
  const state = await service.state();
  assert.equal(state.official[keyOf(ids[0])]?.status, "ok");
  assert.ok(state.official[keyOf(ids[0])]?.fingerprint);

  // 再点一次：都有定论了，不发请求。
  await service.handle({ type: "triage.start", step: "official" }, tab.listener);
  assert.equal(site.count("readOfficialSummary"), 3);
  assert.equal(tab.last("triage.started")?.total, 0);
});

test("第一步：被平台限流就整批停下，后面的不读", async () => {
  let calls = 0;
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 3, dropped: 0, items: ids.slice(0, 3).map((id) => listItem(id)) } }),
    officialSummary: () => ((calls += 1) === 2 ? failed("RATE_LIMITED") : officialOk()),
  });
  const { service, timers, page } = setup({ site });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  const running = service.handle({ type: "triage.start", step: "official" }, tab.listener);
  await tick(timers);
  await running;
  assert.equal(site.count("readOfficialSummary"), 2);
  assert.equal(tab.last("triage.done")?.stop, "rate-limited");
});

test("第一步：点停止不再开始新的，正在读的读完存下", async () => {
  let release: (value: SiteResult<never>) => void = () => {};
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 2, dropped: 0, items: [listItem(ids[0]), listItem(ids[1])] } }),
    officialSummary: () => new Promise((resolve) => void (release = resolve as never)),
  });
  const { service, page } = setup({ site });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  const running = service.handle({ type: "triage.start", step: "official" }, tab.listener);
  assert.ok(await until(() => site.count("readOfficialSummary") === 1));
  await service.handle({ type: "triage.stop" }, tab.listener);
  release(officialOk() as never);
  await running;
  assert.equal(site.count("readOfficialSummary"), 1);
  assert.equal(tab.last("triage.done")?.stop, "stopped");
  assert.equal((await service.state()).official[keyOf(ids[0])]?.status, "ok");
});

test("第二步：只发模型请求，不向平台读；结论跟着概览存下", async () => {
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 2, dropped: 0, items: [listItem(ids[0]), listItem(ids[1])] } }),
    officialSummary: officialOk,
  });
  const { service, harness, timers, page, ensured, materials } = setup({ site, respond: (ask) => (ask.isVerdict ? verdictReply("讲了一件事", "可以跳过") : undefined) });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  const first = service.handle({ type: "triage.start", step: "official" }, tab.listener);
  await tick(timers);
  await first;
  const before = site.calls.length;
  await service.handle({ type: "triage.start", step: "verdict" }, tab.listener);
  assert.equal(site.calls.length, before, "写结论不向平台读");
  assert.deepEqual(ensured, [], "写结论不取字幕");
  assert.equal(harness.verdictAsks().length, 2);
  // 观看进度不进写结论的材料，也不进发给模型的请求：列表项的进度是 PROGRESS 秒、标成看完了。
  assert.equal(materials.length, 2);
  for (const read of materials) {
    const material = JSON.stringify(await read(refOf(ids[0])));
    assert.doesNotMatch(material, /progress|finished/, "材料里没有观看进度的字段");
    assert.ok(!material.includes(String(PROGRESS)), "材料里没有观看进度的值");
  }
  assert.ok(!harness.verdictAsks().some((ask) => JSON.stringify(ask.request).includes(String(PROGRESS))), "发给模型的请求里没有观看进度");
  const state = await service.state();
  assert.equal(state.verdicts[keyOf(ids[0])]?.verdict, "可以跳过");
  assert.equal(tab.last("triage.done")?.done, 2);
});

test("第二步：页面都关了撤掉还在排队的；已经发出的那次照常收尾、存下，收尾前再点回正在收尾，之后不重发", async () => {
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 3, dropped: 0, items: ids.slice(0, 3).map((id) => listItem(id)) } }),
    officialSummary: officialOk,
  });
  const releases: (() => void)[] = [];
  const respond: Respond = (ask) =>
    ask.isVerdict ? new Promise((resolve) => void releases.push(() => resolve(verdictReply()))) : undefined;
  const { service, harness, timers, page } = setup({ site, respond, verdictConcurrency: 1 });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  const first = service.handle({ type: "triage.start", step: "official" }, tab.listener);
  await tick(timers);
  await tick(timers);
  await first;

  const writing = service.handle({ type: "triage.start", step: "verdict" }, tab.listener);
  assert.ok(await until(() => harness.verdictAsks().length === 1));
  service.leave("p1");

  const again = page("p2");
  await service.handle({ type: "triage.start", step: "verdict" }, again.listener);
  assert.equal(again.last("triage.refused")?.failure.code, "BATCH_RUNNING", "在途的那次收尾前不另开一轮");
  for (const release of releases.splice(0)) release();
  await writing;
  assert.equal(harness.verdictAsks().length, 1, "排队的没发出去");
  assert.equal(Object.keys((await service.state()).verdicts).length, 1, "在途的那次照常存下");

  const second = service.handle({ type: "triage.start", step: "verdict" }, again.listener);
  for (let round = 0; round < 2; round += 1) {
    assert.ok(await until(() => releases.length === 1));
    for (const release of releases.splice(0)) release();
  }
  await second;
  assert.equal(harness.verdictAsks().length, 3, "三个视频各写一次，已经写好的不重发");
  assert.equal(Object.keys((await service.state()).verdicts).length, 3);
});

test("第二步：登记还没回来时停下这一轮，回来以后撤掉刚建的任务，不发模型请求、不存结论", async () => {
  let release: () => void = () => {};
  const registerGate = new Promise<void>((resolve) => void (release = resolve));
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 1, dropped: 0, items: [listItem(ids[0])] } }),
    officialSummary: officialOk,
  });
  const { service, harness, page } = setup({ site, registerGate, respond: (ask) => (ask.isVerdict ? verdictReply() : undefined) });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  await service.handle({ type: "triage.start", step: "official" }, tab.listener);
  const writing = service.handle({ type: "triage.start", step: "verdict" }, tab.listener);
  assert.ok(await until(() => tab.last("triage.started")?.step === "verdict"));
  await service.handle({ type: "triage.stop" }, tab.listener);
  release();
  await writing;
  assert.equal(harness.verdictAsks().length, 0, "没有发模型请求");
  assert.equal(harness.tasks.list().length, 0, "刚建的任务撤掉了");
  assert.deepEqual((await service.state()).verdicts, {}, "没有存下结论");
  assert.equal(tab.last("triage.done")?.stop, "stopped");
});

test("第二步：登记还没回来时最后一个页面走了，同样不发模型请求", async () => {
  let release: () => void = () => {};
  const registerGate = new Promise<void>((resolve) => void (release = resolve));
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 1, dropped: 0, items: [listItem(ids[0])] } }),
    officialSummary: officialOk,
  });
  const { service, harness, page } = setup({ site, registerGate, respond: (ask) => (ask.isVerdict ? verdictReply() : undefined) });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  await service.handle({ type: "triage.start", step: "official" }, tab.listener);
  const writing = service.handle({ type: "triage.start", step: "verdict" }, tab.listener);
  assert.ok(await until(() => tab.last("triage.started")?.step === "verdict"));
  service.leave("p1");
  release();
  await writing;
  assert.equal(harness.verdictAsks().length, 0);
  assert.equal(harness.tasks.list().length, 0);
});

test("第二步：AI 服务没设置好时不开始", async () => {
  const site = fakeSiteService({
    watchLater: () => ({ ok: true, value: { total: 1, dropped: 0, items: [listItem(ids[0])] } }),
    officialSummary: officialOk,
  });
  const { service, page, setReady } = setup({ site });
  const tab = page("p1");
  await service.handle({ type: "triage.start", step: "list" }, tab.listener);
  await service.handle({ type: "triage.start", step: "official" }, tab.listener);
  setReady(false);
  await service.handle({ type: "triage.start", step: "verdict" }, tab.listener);
  assert.equal(tab.last("triage.refused")?.failure.code, "NO_AI_CONFIG");
});

// 本窗口全部生成

const watchUrl = (id: string, page?: number) => `https://www.bilibili.com/video/${id}/${page ? `?p=${page}` : ""}`;

const statuses = (event: Extract<BatchOut, { type: "window.state" }> | undefined): WindowEntryStatus[] => event?.run?.entries.map((entry) => entry.status) ?? [];

test("清点：只看地址和标题、本机概览和任务表，不向平台读；跳过已有概览的，同一视频只算一次", async () => {
  const tabs = [
    { url: watchUrl(ids[0]), title: "第一个_哔哩哔哩_bilibili" },
    { url: watchUrl(ids[0]), title: "重复的" },
    { url: watchUrl(ids[1]), title: "第二个" },
    { url: "https://www.bilibili.com/", title: "首页" },
  ];
  const { service, harness, site, ensured, page } = setup({ tabs });
  await harness.generate({ video: keyOf(ids[1]) }).result;
  const before = ensured.length;
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  const counted = panel.last("window.counted");
  assert.deepEqual(counted?.items, [
    { video: keyOf(ids[0]), title: "第一个", state: "to-generate" },
    { video: keyOf(ids[1]), title: "第二个", state: "existing" },
  ]);
  assert.equal(site.calls.length, 0);
  assert.equal(ensured.length, before);
});

test("确认后逐个读字幕、两项之间隔 1.5 秒，新生成的都出结果；关掉侧边栏照常做完，重开时接上", async () => {
  const tabs = ids.slice(0, 3).map((id) => ({ url: watchUrl(id), title: id }));
  const { service, harness, timers, ensured, page } = setup({ tabs });
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  const running = service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  const read = () => new Set(ensured).size;
  assert.ok(await until(() => read() === 1));
  service.leave("panel");
  await tick(timers);
  assert.ok(await until(() => read() === 2));
  await tick(timers);
  await running;
  for (const id of ids.slice(0, 3)) assert.ok(await until(async () => Boolean(await harness.record(keyOf(id)))), id);

  const reopened = page("panel-2");
  await service.handle({ type: "window.watch", windowId: 7 }, reopened.listener);
  assert.ok(await until(() => statuses(reopened.last("window.state")).every((status) => status === "completed")));
  assert.equal(statuses(reopened.last("window.state")).length, 3);
  assert.equal(panel.events.filter((event) => event.type === "window.state").length > 0, true);
});

test("读字幕被限流就整批停下，没轮到的记成停掉，可以单独重来", async () => {
  const tabs = ids.slice(0, 3).map((id) => ({ url: watchUrl(id), title: id }));
  const { service, harness, timers, page } = setup({ tabs, ensureFails: { [ids[0]]: "RATE_LIMITED" } });
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  await service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  const state = panel.last("window.state");
  assert.equal(state?.run?.stop, "rate-limited");
  assert.deepEqual(statuses(state), ["failed", "canceled", "canceled"]);
  assert.equal(timers.due(1500), 0);

  await service.handle({ type: "window.retry", windowId: 7, video: keyOf(ids[1]) }, panel.listener);
  assert.ok(await until(() => statuses(panel.last("window.state"))[1] === "completed"));
  assert.ok(await harness.record(keyOf(ids[1])));
});

test("全部停止：正在生成的停下，没轮到的不再开始", async () => {
  const tabs = ids.slice(0, 3).map((id) => ({ url: watchUrl(id), title: id }));
  const { service, harness, page } = setup({ tabs, respond: (ask) => hang(ask.request.signal) });
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  const running = service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.ok(await until(() => harness.chunkAsks().length >= 1));
  await service.handle({ type: "window.stop", windowId: 7 }, panel.listener);
  await running;
  assert.ok(await until(() => statuses(panel.last("window.state")).every((status) => status === "canceled")));
  assert.equal(panel.last("window.state")?.run?.stopping, false);
  assert.equal(harness.tasks.list().filter((task) => task.state === "running").length, 0);
});

test("清除了本机数据：这一批不再读下一个，也不再登记新的任务", async () => {
  const tabs = ids.slice(0, 3).map((id) => ({ url: watchUrl(id), title: id }));
  const { service, harness, timers, ensured, page } = setup({ tabs, respond: (ask) => hang(ask.request.signal) });
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  const running = service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.ok(await until(() => harness.chunkAsks().length >= 1));
  // 设置页清除：先停下在跑的任务，再在闸门里清。
  harness.tasks.cancelAll({ code: "LOCAL_DATA_CLEARED" });
  await harness.guard.clear("cache", async () => {});
  await tick(timers);
  await running;
  assert.equal(new Set(ensured).size, 1, "清除以后没再读字幕");
  assert.deepEqual(statuses(panel.last("window.state")).slice(1), ["canceled", "canceled"]);
  assert.equal(harness.tasks.list().filter((task) => task.state === "running").length, 0);
});

test("取定配置、登记的工夫点了全部停止：回来以后不开始生成", async () => {
  let release: () => void = () => {};
  const freezeGate = new Promise<void>((resolve) => void (release = resolve));
  const tabs = [{ url: watchUrl(ids[0]), title: "一" }];
  const { service, harness, ensured, page } = setup({ tabs, freezeGate });
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  const running = service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.ok(await until(() => ensured.length === 1));
  await service.handle({ type: "window.stop", windowId: 7 }, panel.listener);
  release();
  await running;
  assert.ok(await until(() => statuses(panel.last("window.state"))[0] === "canceled"));
  assert.equal(harness.chunkAsks().length, 0, "没有发模型请求");
  assert.equal(harness.tasks.list().length, 0, "没有留下任务");
});

test("登记任务还没回来时点了全部停止：回来以后撤掉刚建的任务，不开始生成", async () => {
  let release: () => void = () => {};
  const registerGate = new Promise<void>((resolve) => void (release = resolve));
  const tabs = [{ url: watchUrl(ids[0]), title: "一" }];
  const { service, harness, ensured, page } = setup({ tabs, registerGate });
  const panel = page("panel");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  const running = service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.ok(await until(() => ensured.length === 1));
  // 取定配置走完，正卡在登记上。
  await new Promise((resolve) => setImmediate(resolve));
  await service.handle({ type: "window.stop", windowId: 7 }, panel.listener);
  release();
  await running;
  assert.ok(await until(() => statuses(panel.last("window.state"))[0] === "canceled"));
  assert.equal(harness.chunkAsks().length, 0, "没有发模型请求");
  assert.equal(harness.tasks.list().length, 0, "刚建的任务撤掉了");
  assert.equal(await harness.record(keyOf(ids[0])), null, "没有存下概览");
});

test("没有清点过、或者 AI 服务没设置好时不开始；有一批在跑时不另开", async () => {
  const tabs = [{ url: watchUrl(ids[0]), title: "一" }];
  const { service, page, setReady } = setup({ tabs, respond: (ask) => hang(ask.request.signal) });
  const panel = page("panel");
  await service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.equal(panel.last("window.refused")?.failure.code, "BATCH_NOT_COUNTED");
  await service.handle({ type: "window.count", windowId: 7 }, panel.listener);
  setReady(false);
  await service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.equal(panel.last("window.refused")?.failure.code, "NO_AI_CONFIG");
  setReady(true);
  void service.handle({ type: "window.start", windowId: 7 }, panel.listener);
  assert.ok(await until(() => statuses(panel.last("window.state"))[0] === "running"));
  const other = page("other");
  await service.handle({ type: "window.count", windowId: 7 }, other.listener);
  await service.handle({ type: "window.start", windowId: 7 }, other.listener);
  assert.equal(other.last("window.refused")?.failure.code, "BATCH_RUNNING");
  await service.handle({ type: "window.stop", windowId: 7 }, panel.listener);
});

test("标签页标题去掉站名后缀，空的用视频号顶上", () => {
  assert.equal(titleOfTab("一个视频_哔哩哔哩_bilibili", "BV"), "一个视频");
  assert.equal(titleOfTab("  ", "BV1Sample101"), "BV1Sample101");
});
