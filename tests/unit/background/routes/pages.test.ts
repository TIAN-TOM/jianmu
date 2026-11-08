// 打开设置页和侧边栏：确认前也放行。打开侧边栏前面不夹任何等待，被拒时让页面提示点工具栏图标。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { createFakeChrome, senders, type FakeChromeOptions } from "../../../helpers/chrome.ts";

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome(options);
  return { fake, app: createApp(fake.deps()) };
}

test("清单里没有设置页时打开设置页回 FORBIDDEN，不去调；有设置页时打开", async () => {
  const none = appOn();
  assert.deepEqual(await none.app.dispatch({ type: "options.open", req: {} }, senders.panel()), { ok: false, code: "FORBIDDEN" });
  assert.equal(none.fake.calls.optionsOpened, 0);

  const withPage = appOn({ manifest: { options_page: "pages/options.html" } });
  for (const sender of [senders.panel(), senders.triage(), senders.card()]) {
    assert.deepEqual(await withPage.app.dispatch({ type: "options.open", req: {} }, sender), { ok: true, value: {} });
  }
  assert.equal(withPage.fake.calls.optionsOpened, 3);
});

test("卡片打开侧边栏：分发时就按卡片所在的窗口打开，之后广播让侧边栏跟到卡片所在的标签页", async () => {
  const { app, fake } = appOn();
  const pending = app.dispatch({ type: "panel.open", req: {} }, senders.card(21));
  assert.deepEqual(fake.calls.panelOpens, [2], "还没等任何东西就已经打开了");

  assert.deepEqual(await pending, { ok: true, value: { opened: true } });
  assert.deepEqual(fake.calls.broadcasts, [{ type: "panel.follow", tabId: 21 }]);
});

test("打开侧边栏被浏览器拒绝时，回 needsToolbarClick 让页面改口，不广播", async () => {
  const { app, fake } = appOn({ panelOpenRefused: true });
  assert.deepEqual(await app.dispatch({ type: "panel.open", req: {} }, senders.options()), {
    ok: true,
    value: { opened: false, needsToolbarClick: true },
  });
  assert.deepEqual(fake.calls.broadcasts, []);
});

test("侧边栏和内容脚本发不了打开侧边栏；卡片开关关着时卡片打开设置页回 CARD_DISABLED", async () => {
  const { app, fake } = appOn({ manifest: { options_page: "pages/options.html" }, local: { [SETTINGS_STORAGE_KEY]: { inPageCard: false } } });
  for (const sender of [senders.panel(), senders.content()]) {
    assert.deepEqual(app.dispatch({ type: "panel.open", req: {} }, sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.deepEqual(fake.calls.panelOpens, []);
  assert.deepEqual(await app.dispatch({ type: "options.open", req: {} }, senders.card()), { ok: false, code: "CARD_DISABLED" });
  assert.equal(fake.calls.optionsOpened, 0);
});
