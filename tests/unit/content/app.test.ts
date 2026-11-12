// 内容脚本的启用闸门：确认启用之前不读页面、不挂任何界面，只挂一个收后台消息的监听；确认以后才等页面激活、挂界面。
// 清除全部数据（启用失效）以后整套撤下，重新等确认；再确认一次又挂上。问不到后台时隔一会儿再问。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContentApp, type Surface } from "../../../src/content/app.ts";
import { ASK_RETRY_MS } from "../../../src/content/gate.ts";
import { createContentRuntime, type RuntimeLike } from "../../../src/content/runtime.ts";
import type { VideoRef } from "../../../src/core/video-ref.ts";
import type { SitePage } from "../../../src/sites/page-types.ts";
import { EXTENSION_ID } from "../../helpers/chrome.ts";
import { fakeRuntime } from "../../helpers/fake-runtime.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";
import { until } from "../../helpers/wait-until.ts";

const VIDEO: VideoRef = { platform: "bilibili", videoId: "BV1Sample001", segment: 1 };
const NEEDED = { ok: true, value: { state: "needed", updated: false, items: [] } };
const CURRENT = { ok: true, value: { state: "current" } };

function setup() {
  const fake = fakeRuntime();
  let activation: unknown = NEEDED;
  fake.reply("activation.get", (_req) => activation);
  fake.reply("appearance.get", { value: { ok: true, value: { accentTheme: "ink", inPageCard: true } } });
  fake.reply("playback.info", { value: { ok: true, value: { playedSec: 0, report: true } } });
  // 页面那一头的替身也能当内容脚本这一头用：广播的监听多收一个回复函数，替身不给。
  const like = { ...fake.runtime, getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}` } as unknown as RuntimeLike;
  const runtime = createContentRuntime(() => like, async () => {});

  // 页面的每一次读取都记下来：确认前一次都不该有。
  const pageReads: string[] = [];
  const signals: AbortSignal[] = [];
  let ready: (() => void) | null = null;
  const page: SitePage = {
    rules: { platform: "bilibili", optionalPermission: false, parseWatchUrl: () => VIDEO, canonicalUrl: () => "" },
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
    findMainVideo: () => (pageReads.push("findMainVideo"), { status: "none" }),
    hoverIconAnchor: () => (pageReads.push("hoverIconAnchor"), null),
    cardSlot: () => (pageReads.push("cardSlot"), null),
  };

  const surfaces: { removed: boolean; ticks: number; appearance: unknown[] }[] = [];
  const hooks: string[] = [];
  const timers = manualTimers();
  const app = createContentApp({
    runtime,
    page,
    createSurface() {
      const record = { removed: false, ticks: 0, appearance: [] as unknown[] };
      surfaces.push(record);
      const surface: Surface = {
        tick: () => void (record.ticks += 1),
        videoChanged: () => undefined,
        setAppearance: (view) => void record.appearance.push(view),
        retire: () => undefined,
        remove: () => void (record.removed = true),
      };
      return surface;
    },
    visibility: { hidden: () => false, onChange: () => (hooks.push("visibility"), () => undefined) },
    onMediaLoading: () => (hooks.push("media"), () => undefined),
    every: () => (hooks.push("every"), () => undefined),
    gateTimers: { set: (run, ms) => timers.setTimeout(run, ms), clear: (timer) => timers.clearTimeout(timer) },
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
  fake.broadcast({ type: "appearance.changed", accentTheme: "ochre", inPageCard: true });
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
    fake.broadcast({ type: "appearance.changed", accentTheme: "ochre", inPageCard: true });
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
