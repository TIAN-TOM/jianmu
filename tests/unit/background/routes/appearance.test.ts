// 外观：内容脚本读不到存储，外观和卡片开关经后台读；设置变了只在确认启用之后广播给内容脚本。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { appearanceChange } from "../../../../src/background/routes/appearance.ts";
import { API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION, tubeUrl, WATCH_ORIGIN, type FakeChromeOptions } from "../../../helpers/chrome.ts";

const MANIFEST = { content_scripts: [{ matches: [`${WATCH_ORIGIN}/watch/*`] }] };

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome({ manifest: MANIFEST, ...options });
  return { fake, app: createApp(fake.deps()) };
}

test("外观读取同时带回播放页总结卡片的开关，内容脚本读不到存储只能靠它", async () => {
  const defaults = appOn();
  assert.deepEqual(await defaults.app.dispatch({ type: "appearance.get", req: {} }, senders.content()), {
    ok: true,
    value: { accentTheme: "ink", inPageCard: true },
  });

  const off = appOn({ local: { [SETTINGS_STORAGE_KEY]: { accentTheme: "ochre", inPageCard: false } } });
  for (const sender of [senders.content(), senders.content(tubeUrl()), senders.panel(), senders.triage()]) {
    assert.deepEqual(await off.app.dispatch({ type: "appearance.get", req: {} }, sender), {
      ok: true,
      value: { accentTheme: "ochre", inPageCard: false },
    });
  }
});

test("外观读取不读密钥，回复里只有外观和卡片开关两项", async () => {
  const { app, fake } = appOn({
    local: { [SETTINGS_STORAGE_KEY]: { presetId: "deepseek", aiApiKey: "sk-stray" } },
    session: { [API_KEY_SESSION_KEY]: { key: "sk-session", origin: "https://api.deepseek.com/" } },
  });
  const reply = await app.dispatch({ type: "appearance.get", req: {} }, senders.content());
  assert.deepEqual(Object.keys(reply.ok ? (reply.value as object) : {}).sort(), ["accentTheme", "inPageCard"]);
  assert.deepEqual(fake.calls.storageReads.filter(({ area }) => area === "session"), []);
});

test("设置变更广播给播放页时带上卡片开关，关掉后已打开的页面立刻撤下卡片", async () => {
  const { app, fake } = appOn({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, openTabs: [1] });

  await app.onStorageChanged(
    { [SETTINGS_STORAGE_KEY]: { oldValue: CONFIRMED, newValue: { ...CONFIRMED, accentTheme: "graphite", inPageCard: false } } },
    "local",
  );

  assert.deepEqual(fake.calls.tabMessages, [
    { tabId: 1, message: { type: "appearance.changed", accentTheme: "graphite", inPageCard: false } },
  ]);
});

test("确认启用之后，发过消息的内容脚本和按清单匹配规则查到的标签页都收到，同一个标签页只发一次", async () => {
  const { app, fake } = appOn({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, openTabs: [1, 31] });
  await app.dispatch({ type: "appearance.get", req: {} }, senders.content(undefined, 31));
  await app.dispatch({ type: "appearance.get", req: {} }, senders.content(tubeUrl(), 32));

  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: CONFIRMED, newValue: { ...CONFIRMED, accentTheme: "ochre" } } }, "local");

  assert.deepEqual(fake.calls.tabMessages.map(({ tabId }) => tabId).sort(), [1, 31, 32]);
});

test("确认前设置变了不查标签页、不广播给内容脚本，从没确认和确认过期都一样", async () => {
  for (const stamp of [{}, STALE_CONFIRMATION]) {
    const { app, fake } = appOn({ local: { [SETTINGS_STORAGE_KEY]: stamp }, openTabs: [1] });
    await app.dispatch({ type: "appearance.get", req: {} }, senders.content(undefined, 31));

    await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: stamp, newValue: { ...stamp, accentTheme: "ochre", inPageCard: false } } }, "local");

    assert.deepEqual(fake.calls.tabQueries, [], JSON.stringify(stamp));
    assert.deepEqual(fake.calls.tabMessages, [], JSON.stringify(stamp));
  }
});

test("外观和卡片开关没变、不是本机存储区、不是设置这一项的变化，都不广播", () => {
  const changed = (oldValue: unknown, newValue: unknown, area = "local", key = SETTINGS_STORAGE_KEY) =>
    appearanceChange({ [key]: { oldValue, newValue } }, area);

  assert.equal(changed(CONFIRMED, { ...CONFIRMED, aiModel: "other-model" }), null);
  assert.equal(changed(CONFIRMED, { ...CONFIRMED, accentTheme: "ochre" }, "session"), null);
  assert.equal(changed(CONFIRMED, { ...CONFIRMED, accentTheme: "ochre" }, "local", "jianmu_triage"), null);
  assert.deepEqual(changed(CONFIRMED, { ...CONFIRMED, accentTheme: "unknown-theme", inPageCard: false }), {
    type: "appearance.changed",
    accentTheme: "ink",
    inPageCard: false,
  });
});
