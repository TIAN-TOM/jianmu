// 回收授权的路由：只收设置页；确认前也能用，只碰授权接口，不发平台和模型请求、不查标签页、不读标签页地址。
// 回收读执行那一刻的设置：两次保存紧挨着、两次回收都排在保存之后时，后一次保存的来源不被收。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import type { MessageSender } from "../../../../src/background/senders.ts";
import { createSettingsStore } from "../../../../src/platform/settings-store.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { DATA_CONSENT_CONFIRMED, normalize, type SettingsInput } from "../../../../src/shared/settings-schema.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION, tubeUrl, watchedSender } from "../../../helpers/chrome.ts";
import { fakePermissions, REQUIRED_HOSTS } from "../../../helpers/fake-permissions.ts";

const addressed = (aiBaseUrl: string): SettingsInput => ({
  presetId: "custom",
  protocol: "openai",
  aiBaseUrl,
  aiModel: "chat-model",
  ...DATA_CONSENT_CONFIRMED,
});

function appOn(activation: Record<string, unknown>, granted: readonly string[], aiBaseUrl = "https://api.example.com") {
  const browser = fakePermissions({ granted });
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: { ...normalize(addressed(aiBaseUrl)), ...activation } } });
  const deps = fake.deps({ warn() {}, error() {} });
  const app = createApp({ ...deps, permissions: browser.api, runtime: { ...deps.runtime, getManifest: browser.manifest } });
  const release = (sender: MessageSender = senders.options()) => app.dispatch({ type: "grants.release", req: {} }, sender);
  return { browser, fake, deps, app, release };
}

for (const [state, activation] of [
  ["从没确认", {}],
  ["确认过期", STALE_CONFIRMATION],
  ["已确认", CONFIRMED],
] as const) {
  test(`${state}：设置页能回收用不上的授权，只碰授权接口`, async () => {
    const world = appOn(activation, ["https://api.example.com/*", "https://old.example.org/*"]);
    const reads: string[] = [];
    const reply = await world.release(watchedSender(senders.options(), reads, world.fake.confirmedNow));

    assert.deepEqual(reply, { ok: true, value: { released: ["https://old.example.org/*"], failed: [] } });
    assert.deepEqual(world.browser.removed, ["https://old.example.org/*"]);
    assert.ok(world.browser.origins().includes("https://api.example.com/*"), "当前 AI 地址的来源留着");
    for (const host of REQUIRED_HOSTS) assert.ok(world.browser.origins().includes(host), `${host} 是清单里的必需主机`);
    assert.deepEqual(reads.filter((read) => ["tab.url", "tab.pendingUrl", "tab.title"].includes(read)), []);
    assert.deepEqual(world.fake.calls.tabQueries, []);
    assert.deepEqual(world.fake.calls.tabGets, []);
    assert.deepEqual(world.fake.calls.siteParses, []);
    assert.deepEqual(world.fake.calls.fetches, []);
    assert.deepEqual(world.fake.calls.injections, []);
    assert.equal(world.fake.indexedDB.openCount(), 0);
  });
}

test("侧边栏、粗筛页、卡片、内容脚本和其他扩展页面都发不了，什么都不收", async () => {
  const world = appOn(CONFIRMED, ["https://old.example.org/*"]);
  for (const sender of [senders.panel(), senders.triage(), senders.card(), senders.content(), senders.content(tubeUrl()), senders.otherPage()]) {
    assert.deepEqual(await world.release(sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.deepEqual(world.browser.removeCalls, []);
});

test("只收空请求：带了要保留或要收的来源也不认", async () => {
  const world = appOn(CONFIRMED, ["https://old.example.org/*"]);
  for (const req of [{ keep: ["https://old.example.org/*"] }, { origins: [] }, null, []]) {
    assert.deepEqual(await world.app.dispatch({ type: "grants.release", req }, senders.options()), { ok: false, code: "INVALID_REQUEST" });
  }
  assert.deepEqual(world.browser.removeCalls, []);
});

test("两次保存紧挨着，两次回收都排在保存之后：后一次保存的来源不被收，前一次的收掉", async () => {
  const world = appOn(CONFIRMED, ["https://api.example.com/*"]);
  const store = createSettingsStore({ storage: world.deps.storage, locks: world.deps.locks });

  world.browser.grant("https://first.example.net/");
  const first = await store.save(addressed("https://first.example.net/v1"), (await store.load()).settingsRevision);
  world.browser.grant("https://second.example.net/");
  await store.save(addressed("https://second.example.net/v1"), first.settingsRevision);
  const replies = await Promise.all([world.release(), world.release()]);

  assert.ok(replies.every((reply) => reply.ok));
  assert.ok(world.browser.origins().includes("https://second.example.net/*"));
  assert.equal(world.browser.origins().includes("https://first.example.net/*"), false);
  assert.equal(world.browser.origins().includes("https://api.example.com/*"), false);
});
