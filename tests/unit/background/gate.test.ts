// 真实路由表和首次启用闸门：路由表对照允许矩阵；确认前（从没确认、确认过期）遍历全部路由、发送方和端口，
// 闸门之前不读网页地址、不查标签页；卡片和内容脚本收到的回复和广播里没有密钥。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import type { MessageSender } from "../../../src/background/senders.ts";
import { createRoutes } from "../../../src/background/routes/index.ts";
import type { AnyRoute } from "../../../src/background/router.ts";
import { API_KEY_LOCAL_KEY, API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { DATA_CONSENT_CONFIRMED } from "../../../src/shared/settings-schema.ts";
import {
  CONFIRMED,
  createFakeChrome,
  EXTENSION_ORIGIN,
  senders,
  STALE_CONFIRMATION,
  tubeUrl,
  WATCH_ORIGIN,
  watchedSender,
  type FakeChromeOptions,
} from "../../helpers/chrome.ts";
import { until } from "../../helpers/wait-until.ts";
import { ROUTE_MATRIX, rowOf } from "./route-matrix.ts";

const MANIFEST = { options_page: "pages/options.html", content_scripts: [{ matches: [`${WATCH_ORIGIN}/watch/*`] }] };

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome({ manifest: MANIFEST, openTabs: [61, 62], ...options });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  fake.chrome.runtime.onMessage.addListener(((message: unknown, sender: MessageSender, sendResponse: (value: unknown) => void) => {
    const reply = app.dispatch(message, sender);
    if (reply instanceof Promise) {
      void reply.then(sendResponse);
      return true;
    }
    sendResponse(reply);
    return false;
  }) as never);
  fake.chrome.runtime.onConnect.addListener(((port: Parameters<typeof app.connect>[0]) => app.connect(port)) as never);
  return { fake, app };
}

/** 真实的路由表，依赖都换成不该被调到的替身：这里只看放行规则。 */
const realRoutes = (): Readonly<Record<string, AnyRoute>> =>
  createRoutes({
    settings: { activation: async () => assert.fail(), confirmActivation: async () => assert.fail(), loadPublic: async () => assert.fail() },
    messenger: { toPages: async () => {}, toTabs: async () => {} },
    contentTargets: async () => [],
    tabs: { hasOptionsPage: () => true, openOptionsPage: async () => {} },
    ai: {
      configCheck: async () => assert.fail(),
      listModels: async () => assert.fail(),
      testConnection: async () => assert.fail(),
      freeze: async () => assert.fail(),
    },
    tasks: { register: async () => assert.fail(), cancel: () => assert.fail(), list: () => assert.fail() },
    cardLimits: { admitGenerate: () => assert.fail(), issueToken: () => assert.fail(), redeemToken: () => assert.fail() },
    reinject: async () => assert.fail(),
    grants: { releaseUnused: async () => assert.fail() },
    data: { exportBackup: async () => assert.fail(), importBackup: async () => assert.fail(), clear: async () => assert.fail() },
    sessions: {
      onPlaybackInfo: async () => assert.fail(),
      onMilestone: async () => assert.fail(),
      get: async () => assert.fail(),
      setMode: async () => assert.fail(),
      setCardOverride: async () => assert.fail(),
      onTabRemoved: async () => assert.fail(),
    },
    channels: { clear: async () => assert.fail() },
    playbackLimits: { admitMilestone: () => assert.fail() },
    transcript: {
      get: async () => assert.fail(),
      light: async () => assert.fail(),
      checkAvailable: async () => assert.fail(),
      importFile: async () => assert.fail(),
      removeImport: async () => assert.fail(),
    },
    overview: { generate: async () => assert.fail(), retryFailed: async () => assert.fail(), get: async () => assert.fail() },
    verdict: { fromOfficial: async () => assert.fail() },
    qa: { ask: async () => assert.fail(), history: async () => assert.fail(), remove: async () => assert.fail() },
    explain: { explain: async () => assert.fail() },
    notes: { save: async () => assert.fail(), list: async () => assert.fail(), update: async () => assert.fail(), remove: async () => assert.fail() },
    playerNotePolish: () => assert.fail(),
  });

const ALL_SENDERS: readonly [string, () => MessageSender][] = [
  ["侧边栏", senders.panel],
  ["占一个标签页的侧边栏", () => senders.panelInTab()],
  ["设置页", () => senders.options()],
  ["粗筛页", () => senders.triage()],
  ["其他扩展页面", () => senders.otherPage()],
  ["卡片", () => senders.card()],
  ["一个站的内容脚本", () => senders.content()],
  ["另一个站的内容脚本", () => senders.content(tubeUrl())],
  ["别的扩展", senders.foreign],
  ["认不出的发送方", senders.stray],
];

test("路由表里每条路由的发送方、页面和确认前放不放行，都等于允许矩阵里那一行", () => {
  const routes = realRoutes();
  assert.ok(Object.keys(routes).length > 0);
  for (const [name, route] of Object.entries(routes)) {
    const expected = ROUTE_MATRIX.find((row) => row.name === name && !row.port);
    assert.ok(expected, `${name} 不在允许矩阵里`);
    assert.deepEqual(rowOf(name, route), expected, name);
  }
});

test("确认前放行的路由凡是收内容脚本的，两站都收：确认前永远用不着知道是哪个站", () => {
  for (const row of ROUTE_MATRIX.filter((entry) => entry.beforeEnable && entry.content.length > 0)) {
    assert.deepEqual(row.content, ["bilibili", "youtube"], row.name);
  }
  for (const [name, route] of Object.entries(realRoutes())) {
    if (route.beforeEnable) assert.equal(route.video, undefined, `${name} 确认前放行，不能要发送方的视频`);
  }
});

for (const [state, local] of [
  ["从没确认", {}],
  ["确认过期（存着旧指纹）", { [SETTINGS_STORAGE_KEY]: STALE_CONFIRMATION }],
] as const) {
  test(`${state}：遍历全部路由、发送方和端口，确认前不读标签页地址和标题、不读内容脚本的地址、不查标签页、不解析地址`, async () => {
    const names = Object.keys(realRoutes());
    for (const name of [...names, "not.a.route"]) {
      for (const [label, make] of ALL_SENDERS) {
        const { fake } = appOn({ local: structuredClone(local) });
        const reads: string[] = [];
        const sender = make();
        await fake.send({ type: name, req: {} }, watchedSender(sender, reads, fake.confirmedNow));
        for (const port of ["translate", "batch", "unknown"]) fake.connect(port, watchedSender(sender, reads, fake.confirmedNow));
        // 写日志、广播这些收尾可能晚一轮。
        await until(() => true);

        const where = `${label} → ${name}`;
        assert.deepEqual(reads.filter((read) => ["tab.url", "tab.pendingUrl", "tab.title"].includes(read)), [], where);
        if (sender.origin !== EXTENSION_ORIGIN) {
          assert.equal(reads.includes("sender.url"), false, `${where}：内容脚本的地址`);
        }
        assert.deepEqual(fake.calls.tabQueries.filter((call) => !call.whileConfirmed), [], where);
        assert.deepEqual(fake.calls.tabGets.filter((call) => !call.whileConfirmed), [], where);
        assert.deepEqual(fake.calls.siteParses.filter((call) => !call.whileConfirmed), [], where);
        assert.deepEqual(fake.calls.fetches, [], `${where}：确认前不发模型请求`);
      }
    }
  });
}

test("内容脚本确认前发读启用状态：只登记它的标签页编号，确认以后按编号通知它", async () => {
  const { fake } = appOn({ manifest: {} });

  const status = (await fake.send({ type: "activation.get", req: {} }, senders.content(undefined, 31))) as { ok: boolean };
  assert.equal(status.ok, true);
  assert.deepEqual(fake.calls.tabQueries, []);
  assert.deepEqual(fake.calls.tabMessages, []);

  await fake.send({ type: "activation.confirm", req: {} }, senders.panel());
  assert.deepEqual(fake.calls.tabMessages, [{ tabId: 31, message: { type: "activation.changed", confirmed: true } }]);
  assert.deepEqual(fake.calls.tabQueries, [], "清单里没有内容脚本时不查标签页");
});

test("确认启用只收侧边栏和设置页：卡片、内容脚本、粗筛页、其他扩展页面发不了，什么都不写", async () => {
  for (const sender of [senders.card(), senders.content(), senders.content(tubeUrl()), senders.triage(), senders.otherPage()]) {
    const { fake } = appOn();
    assert.deepEqual(await fake.send({ type: "activation.confirm", req: {} }, sender), { ok: false, code: "FORBIDDEN" });
    assert.equal(fake.confirmedNow(), false);
    assert.deepEqual(fake.calls.broadcasts, []);
  }
});

const SECRET = "sk-SAMPLE-SECRET-FOR-SCAN";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com/";
const KEYED_SETTINGS = { presetId: "deepseek", aiModel: "deepseek-v4-flash", ...DATA_CONSENT_CONFIRMED, ...CONFIRMED };

for (const [mode, options] of [
  ["密钥在会话里", { local: { [SETTINGS_STORAGE_KEY]: KEYED_SETTINGS }, session: { [API_KEY_SESSION_KEY]: { key: SECRET, origin: DEEPSEEK_ORIGIN } } }],
  [
    "记住了密钥",
    {
      local: {
        [SETTINGS_STORAGE_KEY]: { ...KEYED_SETTINGS, rememberApiKey: true },
        [API_KEY_LOCAL_KEY]: { version: 1, key: SECRET, origin: DEEPSEEK_ORIGIN },
      },
    },
  ],
] as const) {
  test(`${mode}：卡片和内容脚本收到的每条回复和广播里都没有密钥`, async () => {
    const { fake, app } = appOn(options);
    const replies: unknown[] = [];
    for (const [name, route] of Object.entries(realRoutes())) {
      for (const sender of [senders.card(), senders.content(), senders.content(tubeUrl())]) {
        if (rowOf(name, route).card || rowOf(name, route).content.length > 0) replies.push(await fake.send({ type: name, req: {} }, sender));
      }
    }
    await fake.send({ type: "activation.get", req: {} }, senders.content());
    await fake.send({ type: "activation.confirm", req: {} }, senders.options());
    await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: KEYED_SETTINGS, newValue: { ...KEYED_SETTINGS, inPageCard: false } } }, "local");

    assert.ok(replies.length >= 4);
    assert.ok(fake.calls.tabMessages.length >= 2, "内容脚本收到了启用和外观两种广播");
    assert.ok(fake.calls.broadcasts.length >= 1, "扩展页面（含卡片）收到了广播");
    const seen = JSON.stringify({ replies, tabs: fake.calls.tabMessages, pages: fake.calls.broadcasts });
    assert.equal(seen.includes(SECRET), false, seen);
  });
}
