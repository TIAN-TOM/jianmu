// 分发顺序，用造好的路由表测：认发送方、认消息、放行、核对形状、手势、启用闸门、站点、卡片开关、处理，出错时回什么。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContentTabs } from "../../../src/background/content-tabs.ts";
import { createRouter, type AnyRoute, type HandlerCtx } from "../../../src/background/router.ts";
import { isEmptyRequest, isVideoKey } from "../../../src/background/routes/validate.ts";
import { createSenders } from "../../../src/background/senders.ts";
import { ok, type Result } from "../../../src/core/errors.ts";
import { createFakeChrome, EXTENSION_ID, extensionUrl, senders, tubeUrl, watchUrl } from "../../helpers/chrome.ts";

const SECRET = "sk-SAMPLE-SECRET-IN-HANDLER";

interface Setup {
  readonly enabled?: boolean;
  readonly cardEnabled?: boolean;
  readonly panelOpens?: boolean;
  readonly routes: Readonly<Record<string, AnyRoute>>;
}

function setup({ enabled = true, cardEnabled = true, panelOpens = true, routes }: Setup) {
  const fake = createFakeChrome();
  const checks = { enabled: 0, cardEnabled: 0 };
  const opens: number[] = [];
  const logged: unknown[][] = [];
  const contentTabs = createContentTabs();
  const router = createRouter({
    routes,
    ports: {},
    senders: createSenders({ extensionId: EXTENSION_ID, extensionUrl, rules: fake.siteRules }),
    async enabled() {
      checks.enabled += 1;
      return enabled;
    },
    async cardEnabled() {
      checks.cardEnabled += 1;
      return cardEnabled;
    },
    contentTabs,
    openPanel(windowId) {
      opens.push(windowId);
      return Promise.resolve(panelOpens);
    },
    log: { warn: (...args: unknown[]) => void logged.push(args), error: (...args: unknown[]) => void logged.push(args) },
  });
  return { fake, router, checks, opens, logged, contentTabs };
}

/** 一条记下调用的路由，默认确认后才放行、只收侧边栏。 */
function route(overrides: Partial<AnyRoute> = {}) {
  const calls: { req: unknown; ctx: HandlerCtx }[] = [];
  const handler = async (req: never, ctx: HandlerCtx): Promise<Result<unknown>> => {
    calls.push({ req, ctx });
    return ok({ done: true });
  };
  return { calls, route: { senders: ["panel"], validate: isEmptyRequest, handler, ...overrides } as AnyRoute };
}

test("认不出的发送方、不是信封的消息、不在表里的消息、发送方不放行：当场同步拒绝，不读启用状态，不登记标签页", () => {
  const plain = route({ senders: ["panel"] });
  const { router, checks, contentTabs } = setup({ routes: { "plain.do": plain.route } });
  const cases: readonly [unknown, Parameters<typeof router.dispatch>[1]][] = [
    [{ type: "plain.do", req: {} }, senders.foreign()],
    [{ type: "plain.do", req: {} }, undefined],
    ["plain.do", senders.panel()],
    [{ type: "plain.do" }, senders.panel()],
    [{ type: "unknown.route", req: {} }, senders.panel()],
    [{ type: "toString", req: {} }, senders.panel()],
    [{ type: "plain.do", req: {} }, senders.content()],
    [{ type: "plain.do", req: {} }, senders.otherPage()],
  ];
  for (const [message, sender] of cases) {
    const reply = router.dispatch(message, sender);
    assert.equal(reply instanceof Promise, false, JSON.stringify(message));
    assert.deepEqual(reply, { ok: false, code: "FORBIDDEN" }, JSON.stringify(message));
  }
  assert.deepEqual(checks, { enabled: 0, cardEnabled: 0 });
  assert.deepEqual(contentTabs.list(), []);
  assert.equal(plain.calls.length, 0);
});

test("扩展页面按页面放行：路由点名的页面才收，认不出的扩展页面一律不收", async () => {
  const optionsOnly = route({ senders: ["page"], pages: ["options"] });
  const { router } = setup({ routes: { "options.only": optionsOnly.route } });

  assert.deepEqual(await router.dispatch({ type: "options.only", req: {} }, senders.options()), ok({ done: true }));
  for (const sender of [senders.triage(), senders.otherPage(), senders.panel(), senders.card()]) {
    assert.deepEqual(router.dispatch({ type: "options.only", req: {} }, sender), { ok: false, code: "FORBIDDEN" });
  }
});

test("没标 beforeEnable 的路由，确认前回 NOT_ENABLED，处理函数不跑；标了的照常处理", async () => {
  const plain = route();
  const early = route({ beforeEnable: true });
  const { router, checks } = setup({ enabled: false, routes: { "plain.do": plain.route, "early.do": early.route } });

  assert.deepEqual(await router.dispatch({ type: "plain.do", req: {} }, senders.panel()), { ok: false, code: "NOT_ENABLED" });
  assert.equal(plain.calls.length, 0);
  assert.deepEqual(await router.dispatch({ type: "early.do", req: {} }, senders.panel()), ok({ done: true }));
  assert.equal(checks.enabled, 1, "确认前放行的不读启用状态");

  const confirmed = setup({ enabled: true, routes: { "plain.do": plain.route } });
  assert.deepEqual(await confirmed.router.dispatch({ type: "plain.do", req: {} }, senders.panel()), ok({ done: true }));
});

test("请求形状不对回 INVALID_REQUEST，在启用闸门之前就拒，处理函数不跑", () => {
  const plain = route();
  const { router, checks } = setup({ enabled: false, routes: { "plain.do": plain.route } });
  for (const req of [{ extra: 1 }, null, [], "x"]) {
    assert.deepEqual(router.dispatch({ type: "plain.do", req }, senders.panel()), { ok: false, code: "INVALID_REQUEST" });
  }
  assert.equal(checks.enabled, 0);
  assert.equal(plain.calls.length, 0);
});

test("要手势的路由：分发时同步打开侧边栏，前面没有任何等待；打开被拒时处理函数拿到 false", async () => {
  const open = route({ senders: ["card"], beforeEnable: true, gesture: "open-panel" });
  const { router, opens } = setup({ panelOpens: false, routes: { "panel.go": open.route } });

  const pending = router.dispatch({ type: "panel.go", req: {} }, senders.card(21));
  assert.deepEqual(opens, [2], "dispatch 还没返回就已经按发送方的窗口打开了");
  await pending;
  assert.equal(await open.calls[0]?.ctx.panelOpened, false);
});

test("卡片开关关着时，卡片发来的消息回 CARD_DISABLED，别的发送方不受影响", async () => {
  const both = route({ senders: ["card", "panel"] });
  const { router, checks } = setup({ cardEnabled: false, routes: { "both.do": both.route } });

  assert.deepEqual(await router.dispatch({ type: "both.do", req: {} }, senders.card()), { ok: false, code: "CARD_DISABLED" });
  assert.deepEqual(await router.dispatch({ type: "both.do", req: {} }, senders.panel()), ok({ done: true }));
  assert.equal(checks.cardEnabled, 1);
  assert.equal(both.calls.length, 1);
});

test("内容脚本：过了放行才登记标签页编号；站点和视频过了闸门才按地址认，站点不对回 FORBIDDEN，认不出视频回 INVALID_REQUEST", async () => {
  const oneSite = route({ senders: ["content:bilibili"] });
  const needsVideo = route({ senders: ["content:bilibili", "content:youtube"], video: "from-sender" });
  const { router, fake, contentTabs } = setup({ routes: { "one.site": oneSite.route, "needs.video": needsVideo.route } });

  assert.deepEqual(await router.dispatch({ type: "one.site", req: {} }, senders.content(tubeUrl(), 41)), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(await router.dispatch({ type: "needs.video", req: {} }, senders.content("https://watch.example/home", 42)), {
    ok: false,
    code: "INVALID_REQUEST",
  });
  assert.deepEqual(await router.dispatch({ type: "needs.video", req: {} }, senders.content(watchUrl(), 43)), ok({ done: true }));
  assert.deepEqual(needsVideo.calls[0]?.ctx.sender, {
    kind: "content",
    tabId: 43,
    windowId: 3,
    frameId: 0,
    site: "bilibili",
    video: { platform: "bilibili", videoId: "BV1Sample001" },
  });
  assert.deepEqual([...contentTabs.list()].sort(), [41, 42, 43]);

  // 确认前要视频的路由回 NOT_ENABLED，地址一次都没解析。
  fake.calls.siteParses.length = 0;
  const closed = setup({ enabled: false, routes: { "needs.video": needsVideo.route } });
  assert.deepEqual(await closed.router.dispatch({ type: "needs.video", req: {} }, senders.content(watchUrl(), 44)), {
    ok: false,
    code: "NOT_ENABLED",
  });
  assert.deepEqual(closed.fake.calls.siteParses, []);
});

test("处理函数出错：设置的错回它的码，两种写满的文案都回 STORAGE_FULL，别的回 BACKGROUND_FAILED，日志里没有密钥", async () => {
  const failing = (error: unknown) =>
    route({
      handler: async () => {
        throw error;
      },
    }).route;
  const stale = Object.assign(new Error("设置刚在别的页面改过"), { code: "SETTINGS_STALE" });
  const { router, logged } = setup({
    routes: {
      stale: failing(stale),
      full: failing(new Error("Resource::kQuotaBytes quota exceeded")),
      fullOld: failing(new Error("QUOTA_BYTES quota exceeded")),
      boom: failing(new Error(`boom ${SECRET}`, { cause: { aiApiKey: SECRET } })),
      odd: failing({ aiApiKey: SECRET }),
    },
  });

  const codes = [];
  for (const type of ["stale", "full", "fullOld", "boom", "odd"]) {
    const reply = await router.dispatch({ type, req: {} }, senders.panel());
    assert.equal(reply.ok, false);
    codes.push(reply.ok ? null : reply.code);
    assert.doesNotMatch(JSON.stringify(reply), new RegExp(SECRET));
  }
  assert.deepEqual(codes, ["SETTINGS_STALE", "STORAGE_FULL", "STORAGE_FULL", "BACKGROUND_FAILED", "BACKGROUND_FAILED"]);
  assert.equal(logged.length, 2, "只有没料到的错记日志");
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(SECRET));
});

test("消息里的视频键要解析得出视频身份，空串和解析不出的拒", () => {
  assert.equal(isVideoKey("bilibili:BV1Sample001:p1"), true);
  assert.equal(isVideoKey("youtube:tube-sample"), true);
  for (const value of ["", "bilibili:", "bilibili::p1", "bilibili:BV1Sample001:p0", null, undefined, 1, {}]) {
    assert.equal(isVideoKey(value), false, JSON.stringify(value));
  }
  assert.equal(isEmptyRequest({}), true);
  for (const [label, value] of [["多了字段", { a: 1 }], ["null", null], ["数组", []], ["没有原型的对象", Object.create(null)]] as const) {
    assert.equal(isEmptyRequest(value), false, label);
  }
});
