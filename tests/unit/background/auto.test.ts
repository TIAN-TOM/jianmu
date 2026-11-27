// 打开就出结论接进后台：标签页和窗口事件经 App 交给自动生成。走真实的后台装配、任务表、取字幕和概览服务，
// 窗口、标签页、站点读取和模型服务是替身。确认前、开关关着时不问窗口、不读地址；开着时开着的长视频都排进来，前台的先，
// 每个只生成一次；授权了的 YouTube 观看页也排进来，经视频页点开文字稿面板读、读完关上；关掉的标签页撤掉；被限流整批停下；侧边栏再点「生成概览」接上同一个任务；额度用完停下，
// 配置检查和广播带出来，重开开关、手动成功一次、点「恢复」后恢复；密钥被拒停着时，设置页保存了新的密钥自己恢复。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { stopsReading } from "../../../src/background/auto.ts";
import { AUTO_READ_GAP_MS } from "../../../src/background/services/auto-generate.ts";
import { PROTOCOLS } from "../../../src/core/ai/provider/index.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { AUTO_LEDGER_KEY, SETTINGS_REVISION_KEY, SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { readFileSync } from "node:fs";
import { createFakeChrome, senders, TUBE_ORIGIN, watchUrl, tubeUrl } from "../../helpers/chrome.ts";
import { chatReply, keyedStorage, modelService, reply, type SentRequest } from "../../helpers/fake-model-service.ts";
import { failed, fakeSiteService, sampleInfo } from "../../helpers/fake-site-service.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model" };
const ORIGIN = "https://gateway.example.com/";
const prompt = (user: string): string => ["## 系统提示词", "```", "系统", "```", "## 用户提示词", "```", user, "```", ""].join("\n");
const PROMPTS = { "skim/chapters.md": prompt("分块 {minTimestampSeconds}"), "skim/verdict.md": prompt("写结论") };
const CHAPTER = JSON.stringify({ chapters: [{ title: "开场", timestampSeconds: 0, summary: "摘要" }], keyQuotes: [] });
const VERDICT = JSON.stringify({ summary: "自动写的结论", value: "有方法", verdict: 3, reason: "要点都在" });

const LONG_ID = "BV1Sample301";
const SHORT_ID = "BV1Sample302";
const OTHER_ID = "BV1Sample303";
const LONG = videoKey({ platform: "bilibili", videoId: LONG_ID });
const OTHER = videoKey({ platform: "bilibili", videoId: OTHER_ID });
const FOCUSED = 1;
const BACKGROUND = 2;
const TEMPLATE = JSON.parse(readFileSync(new URL("../../../manifest.template.json", import.meta.url), "utf8")) as { content_scripts: { matches: string[]; js: string[] }[] };

const isVerdict = (request: SentRequest): boolean => JSON.stringify(request.body).includes("写结论");
const answer = (request: SentRequest) => chatReply(isVerdict(request) ? VERDICT : CHAPTER);

interface Options {
  readonly enabled?: boolean;
  readonly on?: boolean;
  readonly handler?: (request: SentRequest) => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>;
  /** 读字幕时平台怎么回：不给时照常给字幕。 */
  readonly captions?: (videoId: string) => "ok" | "rate-limited" | "none";
  /** 没登录 B 站：视频信息读得到，官方总结和字幕轨要登录。 */
  readonly signedOut?: boolean;
  /** 读取服务换成 YouTube 的，YouTube 已授权；视频页的内容脚本这样回话。 */
  readonly tube?: (message: unknown) => unknown;
}

function appOn({ enabled = true, on = true, handler = answer, captions = () => "ok", signedOut = false, tube }: Options = {}) {
  const ai = modelService(handler);
  const stored = keyedStorage(GATEWAY, ORIGIN);
  const settings = stored.local[SETTINGS_STORAGE_KEY] as Record<string, unknown>;
  const local = { [SETTINGS_STORAGE_KEY]: { ...settings, autoOverview: on, autoOverviewMinutes: 10, ...(enabled ? {} : { activationVersion: 0, activationFingerprint: "" }) } };
  const site = fakeSiteService({
    // 长视频 30 分钟，短视频 5 分钟；字幕时间轴跟时长对得上。
    videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref, { durationSec: ref.videoId === SHORT_ID ? 300 : 1800 }) }),
    captions: (info) =>
      captions(info.ref.videoId) === "rate-limited"
        ? failed("RATE_LIMITED")
        : captions(info.ref.videoId) === "none"
          ? failed("EMPTY_CAPTION_FILE")
          : { ok: true, value: [{ start: 0, duration: 2, text: "第一句" }, { start: 900, duration: 2, text: "第二句" }] },
    ...(signedOut ? { officialSummary: () => failed("NEED_LOGIN"), tracks: () => failed("NEED_LOGIN") } : {}),
  });
  // 获得焦点的窗口前台是长视频；另一个没有焦点的窗口前台是另一个长视频，它是后打开的。
  const windows = {
    focusedWindow: FOCUSED as number | null,
    activeTabs: { [FOCUSED]: { id: 3, url: watchUrl(LONG_ID) }, [BACKGROUND]: { id: 4, url: watchUrl(OTHER_ID) } } as Record<number, { id: number; url: string }>,
    urlTabs: { 3: watchUrl(LONG_ID), 4: watchUrl(OTHER_ID) } as Record<number, string>,
  };
  const service = tube ? { ...site.service, rules: { ...site.service.rules, platform: "youtube" as const } } : site.service;
  const fake = createFakeChrome(
    withWindows(
      {
        local,
        session: stored.session,
        grantedOrigins: tube ? [ORIGIN, `${TUBE_ORIGIN}/*`] : [ORIGIN],
        fetch: ai.fetch,
        prompts: PROMPTS,
        site: service,
        manifest: { content_scripts: TEMPLATE.content_scripts },
        ...(tube ? { tabReply: (_tabId: number, message: unknown) => tube(message) } : {}),
      },
      windows,
    ),
  );
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const ask = (type: string, req: unknown = {}, sender = senders.panel()) => app.dispatch({ type, req }, sender) as Promise<{ ok: boolean; code?: string; value?: any }>;
  const overviewOf = async (video = LONG) => (await ask("overview.get", { video })).value?.overview?.analysis;
  /** 两次读平台之间的间隔用手动计时器排：边推着时钟边等。 */
  const pumped = (check: () => boolean | Promise<boolean>) =>
    until(async () => {
      fake.timers.advance(AUTO_READ_GAP_MS);
      return check();
    });
  return { ai, fake, app, ask, site, windows, overviewOf, pumped };
}

// 替身按调用时读这几项：测试里改了获得焦点的窗口、前台标签页和开着的标签页，下一次问就是新的。
function withWindows<T extends object>(
  options: T,
  state: { focusedWindow: number | null; activeTabs: Record<number, { id: number; url: string }>; urlTabs: Record<number, string> },
): T {
  Object.defineProperty(options, "focusedWindow", { get: () => state.focusedWindow, enumerable: true });
  Object.defineProperty(options, "activeTabs", { get: () => state.activeTabs, enumerable: true });
  Object.defineProperty(options, "urlTabs", { get: () => state.urlTabs, enumerable: true });
  return options;
}

test("确认启用之前、开关关着时：标签页和窗口事件不问窗口、不查标签页、不读地址，也不读平台", async () => {
  for (const options of [{ enabled: false }, { on: false }]) {
    const { app, fake, ai, site } = appOn(options);
    app.onTabActivated();
    app.onTabUpdated({ url: watchUrl(LONG_ID) });
    app.onTabUpdated({ status: "complete" });
    app.onFocusChanged(FOCUSED);
    assert.ok(await stillFalse(() => fake.calls.windowQueries.length + fake.calls.tabQueries.length + fake.calls.siteParses.length + site.calls.length + ai.sent.length > 0), JSON.stringify(options));
  }
});

test("开着时：前台的长视频先生成，后台打开的那个也生成，结论都存下；再切回来不再生成", async () => {
  const { app, ai, overviewOf, pumped, site } = appOn();
  app.onFocusChanged(BACKGROUND);
  assert.ok(await pumped(async () => (await overviewOf())?.verdict?.summary === "自动写的结论"));
  assert.ok(await pumped(async () => (await overviewOf(OTHER))?.verdict?.summary === "自动写的结论"), "后台打开的那个也生成");
  const firstFor = (id: string) => site.calls.findIndex((call) => (call.ref ?? call.info?.ref)?.videoId === id);
  assert.ok(firstFor(LONG_ID) >= 0 && firstFor(LONG_ID) < firstFor(OTHER_ID), "前台的先读");
  const posts = ai.posts().length;
  assert.equal(ai.posts().filter(isVerdict).length, 2);

  app.onTabActivated();
  app.onFocusChanged(FOCUSED);
  assert.ok(await stillFalse(() => ai.posts().length > posts), "同一视频只生成一次");
});

test("刚打开开关：已经开着的视频标签页马上排进来，不等下一个标签页事件", async () => {
  const { app, fake, overviewOf, pumped } = appOn({ on: false });
  const before = fake.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>;
  const after = { ...before, autoOverview: true };
  fake.local.data[SETTINGS_STORAGE_KEY] = after;
  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: before, newValue: after } }, "local");
  assert.ok(await pumped(async () => (await overviewOf())?.verdict?.summary === "自动写的结论"));
});

test("排着的标签页关掉了：撤掉，不为它读平台", async () => {
  const { app, overviewOf, windows, site, pumped } = appOn();
  delete windows.urlTabs[4];
  app.onTabActivated();
  assert.ok(await pumped(async () => (await overviewOf())?.verdict?.summary === "自动写的结论"));
  assert.ok(await stillFalse(() => site.calls.some((call) => call.ref?.videoId === OTHER_ID || call.info?.ref.videoId === OTHER_ID)));
});

test("被限流：整批停下，排着的不接着读", async () => {
  const limited = appOn({ captions: (id) => (id === LONG_ID ? "rate-limited" : "ok") });
  limited.app.onTabActivated();
  assert.ok(await until(() => limited.site.count("readCaptions") > 0));
  // 推着时钟走过好几个间隔：停下了就谁都不再读。
  for (let step = 0; step < 5; step += 1) {
    limited.fake.timers.advance(AUTO_READ_GAP_MS);
    assert.ok(await stillFalse(() => limited.site.calls.some((call) => call.ref?.videoId === OTHER_ID || call.info?.ref.videoId === OTHER_ID)), "前台那个被限流，后台那个不再去读");
  }
  assert.equal(limited.ai.posts().length, 0);

  // 对照：前台那个读不成字幕但不是限流，后台那个照样接着。
  const plain = appOn({ captions: (id) => (id === LONG_ID ? "none" : "ok") });
  plain.app.onTabActivated();
  assert.ok(await plain.pumped(async () => (await plain.overviewOf(OTHER))?.verdict?.summary === "自动写的结论"));
});

test("没登录：轻量读取读得到时长，但字幕要登录，第一个视频就整批停下，不读字幕、不接着读别的", async () => {
  const out = appOn({ signedOut: true });
  out.app.onTabActivated();
  assert.ok(await until(() => out.site.count("readOfficialSummary") > 0));
  for (let step = 0; step < 5; step += 1) {
    out.fake.timers.advance(AUTO_READ_GAP_MS);
    assert.ok(await stillFalse(() => out.site.calls.some((call) => call.ref?.videoId === OTHER_ID || call.info?.ref.videoId === OTHER_ID)), "整批停下，后台那个不读");
  }
  assert.equal(out.site.count("listCaptionTracks"), 0, "不再去读字幕");
  assert.equal(out.ai.posts().length, 0);
});

test("哪些读取失败算整体读不了、要整批停下", () => {
  for (const code of ["RATE_LIMITED", "NEED_LOGIN"] as const) assert.equal(stopsReading(code), "stop", code);
  assert.equal(stopsReading("MALFORMED"), "broken", "读不懂的也停，这个视频另外记下");
  for (const code of ["NO_CAPTIONS", "UNPLAYABLE", "NOT_FOUND", "NETWORK", "TIMEOUT"] as const) assert.equal(stopsReading(code), null, code);
});

test("只认地址变了或加载完成的标签页更新，后台的也算；焦点离开 Chrome 时不判断", async () => {
  const { app, fake } = appOn({ on: false });
  app.onTabUpdated({ title: "换了标题" } as { readonly status?: string });
  app.onFocusChanged(-1);
  assert.ok(await stillFalse(() => fake.calls.storageReads.length > 0), "不读设置，更不读地址");
  app.onTabUpdated({ url: watchUrl(LONG_ID) });
  assert.ok(await until(() => fake.calls.storageReads.length > 0), "后台标签页地址变了也判断");
});

test("短视频（不读字幕）不生成；焦点不在 Chrome 时后台开着的照样生成", async () => {
  const short = appOn();
  short.windows.activeTabs[FOCUSED] = { id: 3, url: watchUrl(SHORT_ID) };
  short.windows.urlTabs = { 3: watchUrl(SHORT_ID) };
  short.app.onTabActivated();
  assert.ok(await until(() => short.site.count("readVideoInfo") > 0));
  assert.ok(await stillFalse(() => short.site.count("readCaptions") + short.ai.posts().length > 0), "本机不知道时长先做轻量读取：时长不够，不读字幕、不发模型请求");

  const away = appOn();
  away.windows.focusedWindow = null;
  away.app.onTabActivated();
  assert.ok(await away.pumped(async () => (await away.overviewOf())?.verdict?.summary === "自动写的结论"));
});

const TUBE = videoKey({ platform: "youtube", videoId: "tube-sample" });
const typeOf = (message: unknown): unknown => (message as { readonly type?: unknown }).type;

test("YouTube：授权了就排进来，经视频页替用户点开文字稿面板，读完关上，再生成", async () => {
  const outcomes: Record<string, string> = { "youtube.openTranscript": "opened", "youtube.closeTranscript": "closed" };
  const { app, fake, windows, overviewOf, pumped } = appOn({ tube: (message) => ({ outcome: outcomes[String(typeOf(message))] }) });
  windows.activeTabs[FOCUSED] = { id: 3, url: tubeUrl() };
  windows.urlTabs = { 3: tubeUrl() };
  app.onTabActivated();
  assert.ok(await pumped(async () => (await overviewOf(TUBE))?.verdict?.summary === "自动写的结论"));
  const asked = fake.calls.tabMessages.map(({ tabId, message }) => [tabId, typeOf(message)]);
  assert.deepEqual(asked, [[3, "youtube.openTranscript"], [3, "youtube.closeTranscript"]], "先点开、读完关上，只对视频所在的标签页");
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
  assert.ok(await stillFalse(() => ai.posts().length > posts), "停着时不再触发，后台排着的也不发");

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

test("额度用完停着时点「恢复」：只收侧边栏和设置页，解除暂停、广播给页面，接着把开着的视频页排进来", async () => {
  let fail = true;
  const quota = reply({ error: { message: "insufficient balance", type: "insufficient_quota" } }, 429);
  const { app, ask, fake, ai, pumped } = appOn({ handler: (request) => (fail ? quota : answer(request)) });
  app.onTabActivated();
  assert.ok(await until(async () => (await ask("config.check")).value?.autoPaused === "quota"));

  for (const sender of [senders.card(), senders.triage(), senders.content(), senders.otherPage()]) {
    assert.deepEqual(await ask("auto.resume", {}, sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.deepEqual(await ask("auto.resume", { now: true }), { ok: false, code: "INVALID_REQUEST" });
  assert.equal((await ask("config.check")).value?.autoPaused, "quota", "被拒的请求不算数");

  fail = false;
  const posts = ai.posts().length;
  assert.deepEqual(await ask("auto.resume", {}, senders.options()), { ok: true, value: {} });
  assert.equal((await ask("config.check")).value?.autoPaused, undefined);
  assert.ok(fake.calls.broadcasts.some((message) => JSON.stringify(message) === JSON.stringify({ type: "auto.changed", paused: null })));
  assert.ok(await pumped(() => ai.posts().length > posts), "恢复以后不等下一个标签页事件，开着的另一个视频接着生成");
  assert.deepEqual(await ask("auto.resume"), { ok: true, value: {} }, "没停着时再点也没事");
});

test("密钥被拒停着：设置页保存了新的密钥或地址就自己恢复；额度用完停着时保存不恢复，要用户自己点", async () => {
  const rejected = reply({ error: { message: "invalid api key" } }, 401);
  const keyed = appOn({ handler: () => rejected });
  keyed.app.onTabActivated();
  assert.ok(await until(async () => (await keyed.ask("config.check")).value?.autoPaused === "key"));
  // 只换了外观、模型这类写入：修订号不变，不恢复。
  await keyed.app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: {}, newValue: {} } }, "local");
  assert.equal((await keyed.ask("config.check")).value?.autoPaused, "key");
  await keyed.app.onStorageChanged({ [SETTINGS_REVISION_KEY]: { oldValue: "旧的修订号", newValue: "新的修订号" } }, "local");
  assert.equal((await keyed.ask("config.check")).value?.autoPaused, undefined);

  const quota = reply({ error: { message: "insufficient balance", type: "insufficient_quota" } }, 429);
  const broke = appOn({ handler: () => quota });
  broke.app.onTabActivated();
  assert.ok(await until(async () => (await broke.ask("config.check")).value?.autoPaused === "quota"));
  await broke.app.onStorageChanged({ [SETTINGS_REVISION_KEY]: { oldValue: "旧的修订号", newValue: "新的修订号" } }, "local");
  assert.equal((await broke.ask("config.check")).value?.autoPaused, "quota");
});
