// 内容脚本的启用闸门：确认启用之前不读页面、不挂任何界面，只挂一个收后台消息的监听；确认以后才等页面激活、挂界面。
// 清除全部数据（启用失效）以后整套撤下，重新等确认；再确认一次又挂上。问不到后台时隔一会儿再问。每次没放行都叫一声。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContentApp, pageSuperseded, type Surface } from "../../../src/content/app.ts";
import type { FrameIdentity, FrameTool } from "../../../src/content/frame.ts";
import { ASK_RETRY_MS } from "../../../src/content/gate.ts";
import { createContentRuntime, type RuntimeLike } from "../../../src/content/runtime.ts";
import type { VideoRef } from "../../../src/core/video-ref.ts";
import { INJECTED } from "../../../src/shared/names.ts";
import type { SitePage } from "../../../src/sites/page-types.ts";
import { EXTENSION_ID } from "../../helpers/chrome.ts";
import { fakeRuntime } from "../../helpers/fake-runtime.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const VIDEO: VideoRef = { platform: "bilibili", videoId: "BV1Sample001", segment: 1 };
const NEEDED = { ok: true, value: { state: "needed", updated: false, items: [] } };
const CURRENT = { ok: true, value: { state: "current" } };

/** page 是几份内容脚本共用的页面：扩展重新加载前后注入的两份只共用它。 */
function setup(
  options: { readonly frame?: (identity: FrameIdentity) => FrameTool; readonly site?: VideoRef["platform"]; readonly durationSec?: number; readonly page?: EventTarget; readonly onHeld?: () => void; readonly onRevoked?: () => void } = {},
) {
  const fake = fakeRuntime();
  let activation: unknown = NEEDED;
  fake.reply("activation.get", (_req) => activation);
  fake.reply("appearance.get", { value: { ok: true, value: { accentTheme: "marker", inPageCard: true, language: "auto" } } });
  fake.reply("playback.info", { value: { ok: true, value: { playedSec: 0, report: true } } });
  // 页面那一头的替身也能当内容脚本这一头用：广播的监听多收一个回复函数，替身不给。
  const like = { ...fake.runtime, getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}` } as unknown as RuntimeLike;
  // 扩展重新加载以后旧脚本拿到的 chrome.runtime 没有 id：disconnect() 模拟这一下。
  let connected = true;
  const runtime = createContentRuntime(() => (connected ? like : ({} as RuntimeLike)), async () => {});

  // 页面的每一次读取都记下来：确认前一次都不该有。
  const pageReads: string[] = [];
  const signals: AbortSignal[] = [];
  let ready: (() => void) | null = null;
  const page: SitePage = {
    rules: { platform: "bilibili", optionalPermission: false, parseWatchUrl: () => VIDEO, canonicalUrl: () => "", permissionOrigins: [], scriptMatches: [] },
    noteShortcut: "n",
    currentRef: () => (pageReads.push("currentRef"), VIDEO),
    onVideoChange: () => (pageReads.push("onVideoChange"), () => undefined),
    whenPageReady(signal) {
      pageReads.push("whenPageReady");
      signals.push(signal);
      return new Promise((resolve, reject) => {
        ready = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    findMainVideo: () => (
      pageReads.push("findMainVideo"),
      options.durationSec === undefined ? { status: "none" } : { status: "found", video: { duration: options.durationSec, paused: true, ended: false, seeking: false, readyState: 4, currentTime: 0, playbackRate: 1 } as HTMLVideoElement }
    ),
    hoverIconAnchor: () => (pageReads.push("hoverIconAnchor"), null),
    cardSlot: () => (pageReads.push("cardSlot"), null),
  };

  const surfaces: { removed: boolean; retired: boolean; ticks: number; appearance: unknown[]; frame: FrameTool | undefined }[] = [];
  const repeating: (() => void)[] = [];
  const hooks: string[] = [];
  const timers = manualTimers();
  const app = createContentApp({
    runtime,
    page,
    createSurface(env) {
      const record = { removed: false, retired: false, ticks: 0, appearance: [] as unknown[], frame: env.frame };
      surfaces.push(record);
      const surface: Surface = {
        tick: () => void (record.ticks += 1),
        videoChanged: () => undefined,
        setAppearance: (view) => void record.appearance.push(view),
        retire: () => void (record.retired = true),
        remove: () => void (record.removed = true),
      };
      return surface;
    },
    visibility: { hidden: () => false, onChange: () => (hooks.push("visibility"), () => undefined) },
    onMediaLoading: () => (hooks.push("media"), () => undefined),
    superseded: pageSuperseded(options.page ?? new EventTarget()),
    every: (_ms, run) => (hooks.push("every"), repeating.push(run), () => undefined),
    gateTimers: { set: (run, ms) => timers.setTimeout(run, ms), clear: (timer) => timers.clearTimeout(timer) },
    ...(options.frame ? { frame: options.frame } : {}),
    ...(options.site ? { site: options.site } : {}),
    ...(options.onHeld ? { onHeld: options.onHeld } : {}),
    ...(options.onRevoked ? { onRevoked: options.onRevoked } : {}),
  });
  return {
    fake,
    app,
    pageReads,
    signals,
    surfaces,
    hooks,
    timers,
    setActivation: (value: unknown) => void (activation = value),
    pageReady: () => ready?.(),
    disconnect: () => void (connected = false),
    tick: () => repeating.forEach((run) => run()),
  };
}

test("确认启用之前：问一次启用状态，只挂一个消息监听，不读页面、不挂界面、不挂别的监听", async () => {
  const { fake, app, pageReads, surfaces, hooks } = setup();
  app.start();
  assert.ok(await until(() => fake.attempts("activation.get") === 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.listeners(), 1);
  assert.deepEqual(pageReads, []);
  assert.deepEqual(hooks, []);
  assert.equal(surfaces.length, 0);
  assert.deepEqual(fake.sent.map(({ type }) => type), ["activation.get"]);

  // 外观、播放器指令和清除广播都不会让它动起来。
  fake.broadcast({ type: "appearance.changed", accentTheme: "redblack", inPageCard: true, language: "auto" });
  fake.broadcast({ type: "player.getState", req: { video: "bilibili:BV1Sample001:p1" } });
  fake.broadcast({ type: "data.cleared", scope: "all" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pageReads, []);
  assert.equal(surfaces.length, 0);
});

test("收到确认启用的广播后再问一次，算数才等页面激活、挂界面；别的扩展发来的广播不算", async () => {
  const { fake, app, pageReads, surfaces, setActivation, pageReady } = setup();
  app.start();
  assert.ok(await until(() => fake.attempts("activation.get") === 1));
  setActivation(CURRENT);
  fake.broadcast({ type: "activation.changed", confirmed: true }, { id: "another-extension" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.attempts("activation.get"), 1);

  fake.broadcast({ type: "activation.changed", confirmed: true });
  assert.ok(await until(() => pageReads.includes("whenPageReady")));
  assert.equal(surfaces.length, 0, "页面激活之前不挂界面");
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  assert.ok(await until(() => surfaces[0]?.appearance.length === 1), "挂上以后才读外观和卡片开关");
  assert.equal(fake.attempts("activation.get"), 2);
});

test("挂上界面的同时先报一次时长，不等下一轮定时：卡片载入时会话已经在路上", async () => {
  const { fake, app, pageReads, surfaces, setActivation, pageReady } = setup({ durationSec: 180 });
  setActivation(CURRENT);
  app.start();
  assert.ok(await until(() => pageReads.includes("whenPageReady")));
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  // 定时一轮都没走过。
  assert.ok(await until(() => fake.attempts("playback.info") === 1));
  assert.deepEqual(fake.sent.find(({ type }) => type === "playback.info")?.req, { video: "bilibili:BV1Sample001:p1", durationSec: 180 });
  assert.equal(surfaces[0]?.ticks, 1);
});

for (const [label, message] of [
  ["启用失效的广播", { type: "activation.changed", confirmed: false }],
  ["清除全部数据的广播", { type: "data.cleared", scope: "all" }],
] as const) {
  test(`${label}：整套撤下，重新等确认；再确认一次又挂上`, async () => {
    const { fake, app, pageReads, surfaces, setActivation, pageReady } = setup();
    setActivation(CURRENT);
    app.start();
    assert.ok(await until(() => pageReads.includes("whenPageReady")));
    pageReady();
    assert.ok(await until(() => surfaces.length === 1));

    setActivation(NEEDED);
    fake.broadcast(message);
    assert.equal(surfaces[0]?.removed, true, "不等后台回答，马上撤下");
    assert.ok(await until(() => fake.attempts("activation.get") === 2));
    await new Promise((resolve) => setImmediate(resolve));
    const readsAfterLoss = pageReads.length;
    fake.broadcast({ type: "appearance.changed", accentTheme: "redblack", inPageCard: true, language: "auto" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pageReads.length, readsAfterLoss, "撤下以后不再读页面");
    assert.equal(surfaces[0]?.appearance.length, 1);

    setActivation(CURRENT);
    fake.broadcast({ type: "activation.changed", confirmed: true });
    assert.ok(await until(() => pageReads.filter((read) => read === "whenPageReady").length === 2));
    pageReady();
    assert.ok(await until(() => surfaces.length === 2));
    assert.equal(surfaces[1]?.removed, false);
  });
}

test("等页面激活的途中启用失效：中止等待，不挂界面", async () => {
  const { fake, app, signals, surfaces, setActivation } = setup();
  setActivation(CURRENT);
  app.start();
  assert.ok(await until(() => signals.length === 1));
  setActivation(NEEDED);
  fake.broadcast({ type: "activation.changed", confirmed: false });
  assert.equal(signals[0]?.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surfaces.length, 0);
});

test("问不到后台时隔一会儿再问，几次以后只等广播", async () => {
  const { fake, app, timers, pageReads } = setup();
  fake.reply("activation.get", () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")));
  app.start();
  for (const [index, wait] of ASK_RETRY_MS.entries()) {
    assert.ok(await until(() => timers.due(wait) === 1), `第 ${index + 1} 次重问排上了`);
    timers.fire(wait);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.pending(), 0);
  assert.deepEqual(pageReads, []);
});

test("没放行时每次都叫一声：问到没启用、清除全部数据以后、问不到都叫；放行了不叫", async () => {
  let held = 0;
  const { fake, app, setActivation } = setup({ onHeld: () => void (held += 1) });
  app.start();
  assert.ok(await until(() => held === 1), "一开始问到没启用");
  setActivation(CURRENT);
  fake.broadcast({ type: "activation.changed", confirmed: true });
  assert.ok(await until(() => fake.attempts("activation.get") === 2));
  assert.ok(await stillFalse(() => held !== 1), "放行了不叫");
  setActivation(NEEDED);
  fake.broadcast({ type: "data.cleared", scope: "all" });
  assert.ok(await until(() => held === 2), "清除全部数据以后");

  let unknown = 0;
  const offline = setup({ onHeld: () => void (unknown += 1) });
  offline.fake.reply("activation.get", () => Promise.reject(new Error("Could not establish connection. Receiving end does not exist.")));
  offline.app.start();
  assert.ok(await until(() => unknown === 1), "问不到后台");
});

test("新注入的一份接手时，旧的一份整套撤下、不再响应广播", async () => {
  const { fake, app, pageReads, surfaces, setActivation, pageReady } = setup();
  setActivation(CURRENT);
  app.start();
  assert.ok(await until(() => pageReads.includes("whenPageReady")));
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  app.stop();
  assert.equal(surfaces[0]?.removed, true);
  assert.equal(fake.listeners(), 0);
});

test("撤了自己这个站的授权：还没问到启用状态也先叫一声再撤下；别的站的撤权、启用的通知不叫", async () => {
  let revoked = 0;
  const { fake, app } = setup({ site: "youtube", onRevoked: () => void (revoked += 1) });
  // 后台一直不回启用状态：闸门从没放行过。
  fake.reply("activation.get", () => new Promise(() => {}));
  app.start();
  assert.ok(await until(() => fake.attempts("activation.get") === 1));
  fake.broadcast({ type: "site.changed", platform: "bilibili", enabled: false });
  fake.broadcast({ type: "site.changed", platform: "youtube", enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revoked, 0);
  fake.broadcast({ type: "site.changed", platform: "youtube", enabled: false });
  assert.ok(await until(() => revoked === 1));
  assert.equal(fake.listeners(), 0);
});

test("撤了自己这个站的授权：整套撤下、不再响应；别的站的撤权和启用的通知不算", async () => {
  const { fake, app, pageReads, surfaces, setActivation, pageReady } = setup({ site: "youtube" });
  setActivation(CURRENT);
  app.start();
  assert.ok(await until(() => pageReads.includes("whenPageReady")));
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  fake.broadcast({ type: "site.changed", platform: "bilibili", enabled: false });
  fake.broadcast({ type: "site.changed", platform: "youtube", enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(surfaces[0]?.removed, false);
  fake.broadcast({ type: "site.changed", platform: "youtube", enabled: false });
  assert.ok(await until(() => surfaces[0]?.removed === true));
  assert.equal(fake.listeners(), 0);
});

test("扩展重新加载以后旧的一份和扩展断了联系：下一轮自查就收场，不再自查", async () => {
  const { app, pageReads, surfaces, setActivation, pageReady, disconnect, tick } = setup();
  setActivation(CURRENT);
  app.start();
  assert.ok(await until(() => pageReads.includes("whenPageReady")));
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  tick();
  const before = surfaces[0]?.ticks ?? 0;
  assert.ok(before > 0);
  disconnect();
  tick();
  assert.equal(surfaces[0]?.retired, true);
  tick();
  assert.equal(surfaces[0]?.ticks, before, "收场以后不再自查");
});

test("补注入的新一份挂上来：和扩展断了联系的旧一份整套撤下；还连着的不理页面上的这个事件，新一份也不撤自己", async () => {
  const page = new EventTarget();
  const old = setup({ page });
  old.setActivation(CURRENT);
  old.app.start();
  assert.ok(await until(() => old.pageReads.includes("whenPageReady")));
  old.pageReady();
  assert.ok(await until(() => old.surfaces.length === 1));

  // 页面脚本也能发这个事件：还连着扩展的那份不理。
  page.dispatchEvent(new CustomEvent(INJECTED.contentRetire));
  assert.equal(old.surfaces[0]?.removed, false);

  // 扩展重新加载：旧的一份断了联系，自查时撤卡片，图标留着提示刷新。
  old.disconnect();
  old.tick();
  assert.deepEqual([old.surfaces[0]?.retired, old.surfaces[0]?.removed], [true, false]);

  // 补注入的新一份在新的隔离世界里，看不到旧的全局变量，靠页面事件叫旧的撤下。
  const fresh = setup({ page });
  fresh.setActivation(CURRENT);
  fresh.app.start();
  assert.equal(old.surfaces[0]?.removed, true, "旧的图标也撤下，页面上不留两套");
  assert.ok(await until(() => fresh.pageReads.includes("whenPageReady")));
  fresh.pageReady();
  assert.ok(await until(() => fresh.surfaces.length === 1));
  page.dispatchEvent(new CustomEvent(INJECTED.contentRetire));
  assert.equal(fresh.surfaces[0]?.removed, false);
});

test("截帧指令：确认以后才建截帧工具、交给它，等它异步回；播放器指令照旧同步回；撤下时停掉截帧工具", async () => {
  const identities: FrameIdentity[] = [];
  const stops: number[] = [];
  const tool: FrameTool = {
    handle: (message) =>
      typeof message === "object" && message !== null && (message as { type?: unknown }).type === "player.captureFrame"
        ? Promise.resolve({ ok: false, code: "FRAME_NOT_READY" })
        : null,
    capture: () => Promise.resolve({ ok: false, code: "FRAME_NOT_READY" }),
    stop: () => void stops.push(1),
  };
  const { fake, app, surfaces, setActivation, pageReady } = setup({
    frame(identity) {
      identities.push(identity);
      return tool;
    },
  });
  const capture = { type: "player.captureFrame", req: { video: "bilibili:BV1Sample001:p1", maxEdge: 1456 } };
  const replies: unknown[] = [];
  const reply = (value: unknown): void => void replies.push(value);

  app.start();
  assert.ok(await until(() => fake.attempts("activation.get") === 1));
  fake.broadcast(capture, undefined, reply);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, [], "确认前不回");
  assert.equal(fake.listenerResults.at(-1), false);
  assert.equal(identities.length, 0, "确认前不建截帧工具");

  setActivation(CURRENT);
  fake.broadcast({ type: "activation.changed", confirmed: true });
  assert.ok(await until(() => identities.length === 1));
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  assert.equal(surfaces[0]?.frame, tool, "播放页图标拿到同一个截帧工具");
  assert.equal(identities[0]?.currentKey(), "bilibili:BV1Sample001:p1");

  fake.broadcast(capture, undefined, reply);
  assert.equal(fake.listenerResults.at(-1), true, "异步回：占着消息通道");
  assert.ok(await until(() => replies.length === 1));
  assert.deepEqual(replies, [{ ok: false, code: "FRAME_NOT_READY" }]);

  fake.broadcast({ type: "player.getState", req: { video: "bilibili:BV1Sample001:p1" } }, undefined, reply);
  assert.equal(fake.listenerResults.at(-1), false);
  assert.deepEqual(replies.at(-1), { ok: false, code: "NO_VIDEO" }, "播放器指令同步回");

  setActivation(NEEDED);
  fake.broadcast({ type: "activation.changed", confirmed: false });
  assert.deepEqual(stops, [1]);
});

test("构建开关关着时没有截帧工具：截帧指令没人回，界面也拿不到", async () => {
  const { fake, app, pageReads, surfaces, setActivation, pageReady } = setup();
  setActivation(CURRENT);
  app.start();
  assert.ok(await until(() => pageReads.includes("whenPageReady")));
  pageReady();
  assert.ok(await until(() => surfaces.length === 1));
  assert.equal(surfaces[0]?.frame, undefined);
  const replies: unknown[] = [];
  fake.broadcast({ type: "player.captureFrame", req: { video: "bilibili:BV1Sample001:p1", maxEdge: 1456 } }, undefined, (value) => void replies.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(replies, []);
  assert.equal(fake.listenerResults.at(-1), false);
});
