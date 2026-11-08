// 补注入：安装、更新之后和确认启用时往已开的视频页补一次内容脚本。确认前不查标签页、不注入；
// 脚本和匹配规则只从清单取；补不上的标签页进确认启用的回复，给侧边栏提示刷新。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION, WATCH_ORIGIN, type FakeChromeOptions } from "../../helpers/chrome.ts";

const SCRIPT = { matches: [`${WATCH_ORIGIN}/watch/*`], js: ["content/watch.js"], css: ["content/watch.css"] };
const MANIFEST = { content_scripts: [SCRIPT] };

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome({ manifest: MANIFEST, openTabs: [61, 62], ...options });
  const warnings: string[] = [];
  const app = createApp(fake.deps({ warn: (message: string) => void warnings.push(message), error() {} }));
  return { fake, app, warnings };
}

const injected = (fake: ReturnType<typeof appOn>["fake"]) => fake.calls.injections.map(({ value }) => value);

for (const [state, local] of [
  ["从没确认", {}],
  ["确认过期", { [SETTINGS_STORAGE_KEY]: STALE_CONFIRMATION }],
] as const) {
  test(`${state}：安装和更新之后都不查标签页、不注入`, async () => {
    const { fake, app } = appOn({ local: structuredClone(local) });
    await app.onInstalled("install");
    await app.onInstalled("update");
    assert.deepEqual(fake.calls.tabQueries, []);
    assert.deepEqual(fake.calls.injections, []);
    assert.equal(fake.calls.panelBehaviors.length, 2, "侧边栏的打开方式照样设");
  });
}

test("确认启用之后对已开的视频页补注入一次：先样式后脚本，文件和匹配规则都照清单", async () => {
  const { fake, app } = appOn();
  assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel()), {
    ok: true,
    value: { state: "current", unreachableTabs: [] },
  });
  assert.deepEqual(injected(fake), [
    { tabId: 61, files: SCRIPT.css },
    { tabId: 62, files: SCRIPT.css },
    { tabId: 61, files: SCRIPT.js },
    { tabId: 62, files: SCRIPT.js },
  ]);
  assert.ok(fake.calls.injections.every((call) => call.whileConfirmed));
  assert.ok(fake.calls.tabQueries.every((call) => call.whileConfirmed));
  assert.ok(fake.calls.tabQueries.some((call) => JSON.stringify(call.value) === JSON.stringify({ url: SCRIPT.matches })));
});

test("补不上的标签页进确认启用的回复，别的照常补；确认照样算数", async () => {
  const { fake, app, warnings } = appOn({ injectRefused: [62] });
  assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, senders.options()), {
    ok: true,
    value: { state: "current", unreachableTabs: [62] },
  });
  assert.equal(fake.confirmedNow(), true);
  assert.deepEqual(
    injected(fake).filter((call) => call.tabId === 61).map((call) => call.files),
    [SCRIPT.css, SCRIPT.js],
  );
  assert.equal(warnings.length, 1);
});

test("已确认时更新扩展：补注入；浏览器自己升级不补", async () => {
  const { fake, app } = appOn({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED } });
  await app.onInstalled("chrome_update");
  assert.deepEqual(fake.calls.injections, []);
  assert.deepEqual(fake.calls.tabQueries, []);

  await app.onInstalled("update");
  assert.deepEqual(
    injected(fake).map((call) => call.tabId),
    [61, 62, 61, 62],
  );
});

test("清单没有内容脚本时什么都不做：不读启用状态、不查标签页、不注入", async () => {
  const { fake, app } = appOn({ manifest: {}, local: { [SETTINGS_STORAGE_KEY]: CONFIRMED } });
  await app.onInstalled("update");
  assert.deepEqual(fake.calls.storageReads, []);
  assert.deepEqual(fake.calls.tabQueries, []);
  assert.deepEqual(fake.calls.injections, []);
  assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel()), {
    ok: true,
    value: { state: "current", unreachableTabs: [] },
  });
  assert.deepEqual(fake.calls.injections, []);
});

test("清单要求注入到全部框架时按全部框架补；只有脚本没有样式时只注入脚本", async () => {
  const manifest = { content_scripts: [{ matches: SCRIPT.matches, js: SCRIPT.js, all_frames: true }] };
  const { fake, app } = appOn({ manifest, local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, openTabs: [61] });
  await app.onInstalled("update");
  assert.deepEqual(injected(fake), [{ tabId: 61, allFrames: true, files: SCRIPT.js }]);
});

test("补注入时查标签页出错：确认照样算数，回执是空的", async () => {
  const { fake, app } = appOn();
  fake.chrome.tabs.query = async () => {
    throw new Error("Invalid url pattern");
  };
  assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel()), {
    ok: true,
    value: { state: "current", unreachableTabs: [] },
  });
  assert.equal(fake.confirmedNow(), true);
  assert.deepEqual(fake.calls.injections, []);
});
