// 打开设置页和侧边栏：确认前也放行。打开侧边栏前面不夹任何等待，被拒时让页面提示点工具栏图标。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { createFakeChrome, extensionUrl, senders, type FakeChromeOptions } from "../../../helpers/chrome.ts";

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

const OPTIONS_PAGE = { options_ui: { page: "pages/options.html" } };
const OPTIONS_URL = extensionUrl("pages/options.html");

test("带节名打开设置页：没开着时新开一个标签页，地址带上节名，不走只会停在顶上的打开方式", async () => {
  const { app, fake } = appOn({ manifest: OPTIONS_PAGE, contexts: [{ contextType: "SIDE_PANEL", documentUrl: extensionUrl("pages/sidepanel.html"), tabId: -1, windowId: 2 }] });
  for (const [sender, section] of [[senders.panel(), "ai-service"], [senders.card(), "ai-service"], [senders.panel(), "youtube"]] as const) {
    assert.deepEqual(await app.dispatch({ type: "options.open", req: { section } }, sender), { ok: true, value: {} });
  }
  assert.deepEqual(fake.calls.tabsCreated, [`${OPTIONS_URL}#ai-service`, `${OPTIONS_URL}#ai-service`, `${OPTIONS_URL}#youtube`]);
  assert.equal(fake.calls.optionsOpened, 0);
  assert.deepEqual(fake.calls.tabUpdates, []);
});

test("带节名打开设置页：已经开着时切到那个标签页、窗口拿焦点，地址换成带节名的，不另开", async () => {
  const contexts = [
    { contextType: "SIDE_PANEL", documentUrl: extensionUrl("pages/sidepanel.html"), tabId: -1, windowId: 2 },
    { contextType: "TAB", documentUrl: extensionUrl("pages/triage.html"), tabId: 5, windowId: 2 },
    { contextType: "TAB", documentUrl: `${OPTIONS_URL}#youtube`, tabId: 7, windowId: 3 },
  ];
  const { app, fake } = appOn({ manifest: OPTIONS_PAGE, contexts });
  assert.deepEqual(await app.dispatch({ type: "options.open", req: { section: "ai-service" } }, senders.panel()), { ok: true, value: {} });
  assert.deepEqual(fake.calls.tabUpdates, [{ tabId: 7, props: { url: `${OPTIONS_URL}#ai-service`, active: true } }]);
  assert.deepEqual(fake.calls.windowUpdates, [{ windowId: 3, props: { focused: true } }]);
  assert.deepEqual(fake.calls.tabsCreated, []);
  assert.equal(fake.calls.optionsOpened, 0);
});

test("打开设置页只认白名单里的节名：不认识的、空的、不是字符串的、多带字段的都拒，什么都不打开", async () => {
  const { app, fake } = appOn({ manifest: OPTIONS_PAGE });
  for (const req of [{ section: "appearance" }, { section: "" }, { section: "AI-SERVICE" }, { section: 1 }, { section: null }, { section: "ai-service", extra: true }, { other: "ai-service" }]) {
    assert.deepEqual(await app.dispatch({ type: "options.open", req }, senders.panel()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.deepEqual(fake.calls.tabsCreated, []);
  assert.deepEqual(fake.calls.tabUpdates, []);
  assert.equal(fake.calls.optionsOpened, 0);
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
