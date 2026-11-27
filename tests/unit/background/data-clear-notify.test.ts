// 清除全部数据时通知已开的视频页：趁启用还算数先查好，清到一半出错也通知，查太久不拖住清除，通知不等页面回话；
// 只清缓存或删笔记不查也不通知。按地址查已开页面之前都核对启用。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContentTargets } from "../../../src/background/content-tabs.ts";
import { createDataService, OPEN_PAGES_WAIT_MS, type DataServiceDeps } from "../../../src/background/services/data.ts";
import { createClearGuard } from "../../../src/core/clear-guard.ts";
import { createFakeChrome } from "../../helpers/chrome.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";
import { until } from "../../helpers/wait-until.ts";

const LOST = { type: "activation.changed", confirmed: false };

function service(overrides: Partial<DataServiceDeps> = {}) {
  const notified: { tabIds: readonly number[]; message: unknown }[] = [];
  let looked = 0;
  const timers = manualTimers();
  const data = createDataService({
    notes: { all: async () => [], update: async () => null },
    overviews: { all: async () => [], update: async () => null },
    qa: { all: async () => [], commit: async () => true },
    translations: { all: async () => [], update: async () => null },
    guard: createClearGuard(),
    tasks: { cancelAll: () => {} },
    settings: { clearAll: async () => {} },
    storage: createFakeChrome().deps({ warn() {}, error() {} }).storage,
    forgetMemory: () => {},
    clearStore: async () => {},
    broadcast: () => {},
    openPages: async () => (looked += 1, [5, 6]),
    toTabs: async (tabIds, message) => void notified.push({ tabIds, message }),
    now: () => 0,
    timers,
    ...overrides,
  });
  return { data, notified, timers, looked: () => looked };
}

test("清除全部数据：查好的页面清完通知；设置删到一半出错也通知，错照旧报给设置页", async () => {
  const ok = service();
  await ok.data.clear("all");
  assert.deepEqual(ok.notified, [{ tabIds: [5, 6], message: LOST }]);

  const broken = service({ settings: { clearAll: async () => Promise.reject(new Error("会话存储坏了")) } });
  await assert.rejects(broken.data.clear("all"), /会话存储坏了/);
  assert.deepEqual(broken.notified, [{ tabIds: [5, 6], message: LOST }]);
});

test("查已开的页面一直没回：最多等一会儿，清除照常做完，不通知查不到的", async () => {
  const stuck = service({ openPages: () => new Promise<readonly number[]>(() => {}) });
  const clearing = stuck.data.clear("all");
  assert.ok(await until(() => stuck.timers.due(OPEN_PAGES_WAIT_MS) === 1));
  stuck.timers.fire(OPEN_PAGES_WAIT_MS);
  await clearing;
  assert.deepEqual(stuck.notified, []);
  assert.equal(stuck.data.busy(), false);
});

test("查已开的页面出错：当作没查到，清除照常做完，不通知", async () => {
  const broken = service({ openPages: () => Promise.reject(new Error("查不到")) });
  await broken.data.clear("all");
  assert.deepEqual(broken.notified, []);
  assert.equal(broken.data.busy(), false);
  assert.equal(broken.timers.pending(), 0);
});

test("页面一直不回话：清除不等它，设置页照常收到回执", async () => {
  const silent = service({ toTabs: () => new Promise<void>(() => {}) });
  await silent.data.clear("all");
  assert.equal(silent.data.busy(), false);
});

test("只清缓存或删笔记：不查已开的页面，也不通知启用失效", async () => {
  for (const scope of ["cache", "notes"] as const) {
    const only = service();
    await only.data.clear(scope);
    assert.equal(only.looked(), 0);
    assert.deepEqual(only.notified, []);
  }
});

test("按地址查已开页面之前都核对启用：从没确认只给登记过的；两次查之间启用失效就不再查", async () => {
  const queries: string[] = [];
  let active = false;
  const targets = createContentTargets({
    registered: { list: () => [3] },
    tabs: {
      contentScriptTabs: async () => (queries.push("manifest"), (active = false), [5]),
      tabsMatching: async () => (queries.push("site"), [71]),
    },
    siteScripts: async () => [{ matches: ["https://tube.example/*"], js: ["content/youtube.js"], css: [], allFrames: false }],
    enabled: async () => active,
  });
  assert.deepEqual(await targets.all(), [3]);
  assert.deepEqual(queries, []);
  // 查完清单那一份时启用失效了（比如这时清除了全部数据）：YouTube 那一份不再按地址查。
  active = true;
  assert.deepEqual(await targets.all(), [3, 5]);
  assert.deepEqual(queries, ["manifest"]);
});
