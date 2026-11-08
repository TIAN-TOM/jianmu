// 首次启用：读启用状态、确认启用。确认前也放行；确认写进设置后广播给扩展页面和内容脚本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { ACTIVATION_TABLE } from "../../../../src/core/consent.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { activationStatus } from "../../../../src/shared/settings-schema.ts";
import { createFakeChrome, senders, STALE_CONFIRMATION, type FakeChromeOptions } from "../../../helpers/chrome.ts";

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome(options);
  return { fake, app: createApp(fake.deps({ warn() {}, error() {} })) };
}

test("没确认过时读到完整说明；确认过期时提示说明有更新", async () => {
  const fresh = appOn();
  const everything = { state: "needed", updated: false, items: ACTIVATION_TABLE.flatMap((row) => row.items) };
  assert.deepEqual(activationStatus({}), everything);
  assert.deepEqual(await fresh.app.dispatch({ type: "activation.get", req: {} }, senders.content()), { ok: true, value: everything });

  const stale = appOn({ local: { [SETTINGS_STORAGE_KEY]: STALE_CONFIRMATION } });
  const updated = (await stale.app.dispatch({ type: "activation.get", req: {} }, senders.panel())) as { value?: { updated?: boolean } };
  assert.equal(updated.value?.updated, true);
});

test("侧边栏或设置页确认启用：写进设置、回已确认，广播给扩展页面；之后普通路由不再挡", async () => {
  for (const sender of [senders.panel(), senders.options()]) {
    const { app, fake } = appOn();
    assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, sender), { ok: true, value: { state: "current", unreachableTabs: [] } });
    assert.equal(fake.confirmedNow(), true);
    assert.deepEqual(fake.calls.broadcasts, [{ type: "activation.changed", confirmed: true }]);
    assert.deepEqual(await app.dispatch({ type: "activation.get", req: {} }, senders.triage()), { ok: true, value: { state: "current" } });
  }
});

test("确认启用时存储写满：回 STORAGE_FULL，确认没写进去，不广播", async () => {
  const { app, fake } = appOn();
  fake.local.set = async () => {
    throw new Error("Resource::kQuotaBytes quota exceeded");
  };
  assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, senders.options()), { ok: false, code: "STORAGE_FULL" });
  assert.equal(fake.confirmedNow(), false);
  assert.deepEqual(fake.calls.broadcasts, []);
});

test("确认启用后查标签页出错：确认照样算数、回已确认，通知照发给登记过的内容脚本", async () => {
  const { app, fake } = appOn({ manifest: { content_scripts: [{ matches: ["https://watch.example/watch/*"] }] } });
  fake.chrome.tabs.query = async () => {
    throw new Error("Invalid url pattern");
  };
  await app.dispatch({ type: "activation.get", req: {} }, senders.content(undefined, 31));

  assert.deepEqual(await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel()), { ok: true, value: { state: "current", unreachableTabs: [] } });
  assert.equal(fake.confirmedNow(), true);
  assert.deepEqual(fake.calls.tabMessages, [{ tabId: 31, message: { type: "activation.changed", confirmed: true } }]);
});
