// 打开就出结论接进后台：标签页和窗口事件经 App 交给自动生成。走真实的后台装配、任务表、取字幕和概览服务，
// 窗口、标签页、站点读取和模型服务是替身。确认前、开关关着时不问窗口、不读地址；开着时只为获得焦点的窗口前台的长视频生成一次；
// 侧边栏再点「生成概览」接上同一个任务；额度用完停下，配置检查和广播带出来，重开开关或手动成功一次后恢复。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { PROTOCOLS } from "../../../src/core/ai/provider/index.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { AUTO_LEDGER_KEY, SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { createFakeChrome, senders, watchUrl, tubeUrl } from "../../helpers/chrome.ts";
import { chatReply, keyedStorage, modelService, reply, type SentRequest } from "../../helpers/fake-model-service.ts";
import { fakeSiteService, sampleInfo } from "../../helpers/fake-site-service.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model" };
const ORIGIN = "https://gateway.example.com/";
const prompt = (user: string): string => ["## 系统提示词", "```", "系统", "```", "## 用户提示词", "```", user, "```", ""].join("\n");
const PROMPTS = { "skim/chapters.md": prompt("分块 {minTimestampSeconds}"), "skim/verdict.md": prompt("写结论") };
const CHAPTER = JSON.stringify({ chapters: [{ title: "开场", timestampSeconds: 0, summary: "摘要" }], keyQuotes: [] });
const VERDICT = JSON.stringify({ summary: "自动写的结论", value: "有方法", verdict: "可以看", reason: "要点都在" });

const LONG_ID = "BV1Sample301";
const SHORT_ID = "BV1Sample302";
const OTHER_ID = "BV1Sample303";
const LONG = videoKey({ platform: "bilibili", videoId: LONG_ID });
const FOCUSED = 1;
const BACKGROUND = 2;

const isVerdict = (request: SentRequest): boolean => JSON.stringify(request.body).includes("写结论");
const answer = (request: SentRequest) => chatReply(isVerdict(request) ? VERDICT : CHAPTER);

interface Options {
  readonly enabled?: boolean;
  readonly on?: boolean;
  readonly handler?: (request: SentRequest) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>;
}

function appOn({ enabled = true, on = true, handler = answer }: Options = {}) {
  const ai = modelService(handler);
  const stored = keyedStorage(GATEWAY, ORIGIN);
  const settings = stored.local[SETTINGS_STORAGE_KEY] as Record<string, unknown>;
  const local = { [SETTINGS_STORAGE_KEY]: { ...settings, autoOverview: on, autoOverviewMinutes: 10, ...(enabled ? {} : { activationVersion: 0, activationFingerprint: "" }) } };
  const site = fakeSiteService({
    // 长视频 30 分钟，短视频 5 分钟；字幕时间轴跟时长对得上。
    videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref, { durationSec: ref.videoId === SHORT_ID ? 300 : 1800 }) }),
    captions: () => ({ ok: true, value: [{ start: 0, duration: 2, text: "第一句" }, { start: 900, duration: 2, text: "第二句" }] }),
  });
  // 获得焦点的窗口前台是长视频；另一个没有焦点的窗口前台是另一个长视频。
  const windows = { focusedWindow: FOCUSED as number | null, activeTabs: { [FOCUSED]: { id: 3, url: watchUrl(LONG_ID) }, [BACKGROUND]: { id: 4, url: watchUrl(OTHER_ID) } } as Record<number, { id: number; url: string }> };
  const fake = createFakeChrome(withWindows({ local, session: stored.session, grantedOrigins: [ORIGIN], fetch: ai.fetch, prompts: PROMPTS, site: site.service }, windows));
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const ask = (type: string, req: unknown = {}, sender = senders.panel()) => app.dispatch({ type, req }, sender) as Promise<{ ok: boolean; code?: string; value?: any }>;
  const overviewOf = async (video = LONG) => (await ask("overview.get", { video })).value?.overview?.analysis;
  return { ai, fake, app, ask, site, windows, overviewOf };
}

// 替身按调用时读这两项：测试里改了获得焦点的窗口和前台标签页，下一次问就是新的。
function withWindows<T extends object>(options: T, state: { focusedWindow: number | null; activeTabs: Record<number, { id: number; url: string }> }): T {
  Object.defineProperty(options, "focusedWindow", { get: () => state.focusedWindow, enumerable: true });
  Object.defineProperty(options, "activeTabs", { get: () => state.activeTabs, enumerable: true });
  return options;
}

test("确认启用之前、开关关着时：标签页和窗口事件不问窗口、不查标签页、不读地址，也不读平台", async () => {
  for (const options of [{ enabled: false }, { on: false }]) {
    const { app, fake, ai, site } = appOn(options);
    app.onTabActivated();
    app.onTabUpdated({ url: watchUrl(LONG_ID) }, { active: true });
    app.onTabUpdated({ status: "complete" }, { active: true });
    app.onFocusChanged(FOCUSED);
    assert.ok(await stillFalse(() => fake.calls.windowQueries.length + fake.calls.tabQueries.length + fake.calls.siteParses.length + site.calls.length + ai.sent.length > 0), JSON.stringify(options));
  }
});

test("开着时：获得焦点的窗口前台的长视频生成一次，结论存下；别的窗口的前台、再切回来都不再生成", async () => {
  const { app, ai, overviewOf, windows } = appOn();
  app.onFocusChanged(BACKGROUND);
  assert.ok(await until(async () => (await overviewOf())?.verdict?.summary === "自动写的结论"));
  const posts = ai.posts().length;
  assert.equal(ai.posts().filter(isVerdict).length, 1);
  assert.ok(ai.posts().every((request) => !JSON.stringify(request.body).includes(OTHER_ID)), "没有焦点的窗口里的前台标签页不生成");

  app.onTabActivated();
  app.onFocusChanged(FOCUSED);
  windows.activeTabs[FOCUSED] = { id: 3, url: watchUrl(LONG_ID) };
  assert.ok(await stillFalse(() => ai.posts().length > posts), "同一视频只生成一次");
});

test("只认地址变了或加载完成、在前台的标签页更新；焦点离开 Chrome 时不判断", async () => {
  const { app, fake } = appOn({ on: false });
  app.onTabUpdated({ title: "换了标题" } as { readonly status?: string }, { active: true });
  app.onTabUpdated({ url: watchUrl(LONG_ID) }, { active: false });
  app.onFocusChanged(-1);
  assert.ok(await stillFalse(() => fake.calls.storageReads.length > 0), "不读设置，更不读地址");
  app.onTabUpdated({ status: "complete" }, { active: true });
  assert.ok(await until(() => fake.calls.storageReads.length > 0));
});

test("短视频（不读字幕）和 YouTube 视频不生成；焦点不在 Chrome 时也不生成", async () => {
  const short = appOn();
  short.windows.activeTabs[FOCUSED] = { id: 3, url: watchUrl(SHORT_ID) };
  short.app.onTabActivated();
  assert.ok(await until(() => short.site.count("readVideoInfo") > 0));
  assert.ok(await stillFalse(() => short.site.count("readCaptions") + short.ai.posts().length > 0), "本机不知道时长先做轻量读取：时长不够，不读字幕、不发模型请求");

  const tube = appOn();
  tube.windows.activeTabs[FOCUSED] = { id: 3, url: tubeUrl() };
  tube.app.onTabActivated();
  assert.ok(await stillFalse(() => tube.site.calls.length + tube.ai.sent.length > 0));

  const away = appOn();
  away.windows.focusedWindow = null;
  away.app.onTabActivated();
  assert.ok(await stillFalse(() => away.site.calls.length + away.ai.sent.length > 0));
});

test("自动生成在跑时侧边栏点「生成概览」：接上同一个任务，不另发", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { app, ask, ai, overviewOf } = appOn({ handler: async (request) => (await gate, answer(request)) });
  app.onTabActivated();
  assert.ok(await until(() => ai.posts().length > 0));
  const running = (await ask("task.list")).value.tasks;
  assert.equal(running.length, 1);
  assert.equal(running[0].origin, "auto");

  const started = await ask("task.start", { kind: "overview", video: LONG });
  assert.ok(started.ok);
  assert.deepEqual([started.value.joined, started.value.task.id], [true, running[0].id]);
  const card = await ask("task.start", { kind: "overview", video: LONG }, senders.card());
  assert.equal(card.value?.joined, true, "卡片也接上它");

  release();
  assert.ok(await until(async () => (await overviewOf())?.verdict?.summary === "自动写的结论"));
  assert.equal(ai.posts().filter(isVerdict).length, 1);
});

test("额度用完：停掉自动生成，配置检查带上、广播给页面；关掉再打开开关后恢复", async () => {
  const quota = reply({ error: { message: "insufficient balance", type: "insufficient_quota" } }, 429);
  const { app, ask, fake, ai, windows } = appOn({ handler: () => quota });
  app.onTabActivated();
  assert.ok(await until(async () => (await ask("config.check")).value?.autoPaused === "quota"));
  assert.ok(fake.calls.broadcasts.some((message) => JSON.stringify(message) === JSON.stringify({ type: "auto.changed", paused: "quota" })));
  const posts = ai.posts().length;

  windows.activeTabs[FOCUSED] = { id: 5, url: watchUrl(OTHER_ID) };
  app.onTabActivated();
  assert.ok(await stillFalse(() => ai.posts().length > posts), "停着时不再触发");

  const settings = fake.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>;
  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: settings, newValue: { ...settings, autoOverview: false } } }, "local");
  assert.equal((await ask("config.check")).value?.autoPaused, undefined);
  assert.ok(fake.calls.broadcasts.some((message) => JSON.stringify(message) === JSON.stringify({ type: "auto.changed", paused: null })));
  assert.equal((fake.session.data[AUTO_LEDGER_KEY] as { paused?: unknown }).paused, undefined);
});

test("手动成功生成一次概览：从暂停里恢复；本机已有的直接交回不算", async () => {
  let fail = true;
  const quota = reply({ error: { message: "quota exceeded", type: "insufficient_quota" } }, 429);
  const { app, ask } = appOn({ handler: (request) => (fail ? quota : answer(request)) });
  app.onTabActivated();
  assert.ok(await until(async () => (await ask("config.check")).value?.autoPaused === "quota"));

  fail = false;
  const other = videoKey({ platform: "bilibili", videoId: OTHER_ID });
  const task = await ask("task.start", { kind: "overview", video: other });
  const result = await ask("overview.start", { video: other, taskId: task.value.task.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await ask("config.check")).value?.autoPaused, undefined);
});
