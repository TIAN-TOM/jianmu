// 后台和真实清单里的内容脚本：确认启用时按清单模板补注入 B 站内容脚本；启用失效（清除全部数据）时，
// 只按编号通知发过消息的内容脚本撤下界面，不再按地址查标签页；从没确认过时设置怎么变都不通知。
// 设置页点清除全部数据时，趁启用还算数先按地址查好已开的视频页，清完一并通知：后台重启过、内存里没登记的页面也收得到。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { activationDropped } from "../../../src/background/routes/activation.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION, TUBE_ORIGIN, tubeUrl } from "../../helpers/chrome.ts";
import { until } from "../../helpers/wait-until.ts";

const TEMPLATE = JSON.parse(readFileSync(new URL("../../../manifest.template.json", import.meta.url), "utf8")) as {
  readonly content_scripts: readonly { readonly matches: readonly string[]; readonly js: readonly string[] }[];
};

test("确认启用后按清单模板里的匹配规则查标签页，补注入清单里的内容脚本", async () => {
  const fake = createFakeChrome({ manifest: { content_scripts: TEMPLATE.content_scripts }, openTabs: [5] });
  const app = createApp(fake.deps());
  const reply = await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel());
  assert.equal(reply.ok, true);
  const [script] = TEMPLATE.content_scripts;
  assert.ok(script && script.js.length === 1);
  assert.ok(fake.calls.tabQueries.some(({ value }) => JSON.stringify(value) === JSON.stringify({ url: script.matches })));
  assert.deepEqual(
    fake.calls.injections.map(({ value }) => value),
    [{ tabId: 5, files: script.js }],
  );
});

test("清除全部数据让启用失效：只按编号通知发过消息的内容脚本，不查标签页", async () => {
  const fake = createFakeChrome({ manifest: { content_scripts: TEMPLATE.content_scripts }, local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, openTabs: [5, 6] });
  const app = createApp(fake.deps());
  await app.dispatch({ type: "activation.get", req: {} }, senders.content(undefined, 7));

  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: CONFIRMED, newValue: undefined } }, "local");

  assert.deepEqual(fake.calls.tabMessages, [{ tabId: 7, message: { type: "activation.changed", confirmed: false } }]);
  assert.deepEqual(fake.calls.tabQueries, []);
});

const LOST = JSON.stringify({ type: "activation.changed", confirmed: false });
const lostTabs = (fake: ReturnType<typeof createFakeChrome>) =>
  fake.calls.tabMessages
    .filter(({ message }) => JSON.stringify(message) === LOST)
    .map(({ tabId }) => tabId)
    .sort((a, b) => a - b);

// 一个 B 站播放页、一个 YouTube 观看页、一个不相干的页面：按匹配规则筛，各查各的。
const PAGES = { 5: "https://www.bilibili.com/video/BV1Sample001", 71: tubeUrl(), 9: "https://unrelated.example/" };

test("清除全部数据：趁启用还算数按两站的匹配规则查好已开的视频页，清完叫它们撤下；后台刚重启、页面一直没出声也通知得到", async () => {
  const fake = createFakeChrome({ manifest: { content_scripts: TEMPLATE.content_scripts }, local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, urlTabs: PAGES, matchUrlTabs: true, grantedOrigins: [`${TUBE_ORIGIN}/*`] });
  // 新建的后台就是刚重启的样子：内存里一个登记的标签页都没有。
  const app = createApp(fake.deps());
  assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope: "all" } }, senders.options()), { ok: true, value: {} });
  assert.ok(await until(() => lostTabs(fake).length === 2));
  assert.deepEqual(lostTabs(fake), [5, 71]);
});

test("没授权 YouTube 时清除全部数据：只按 B 站的规则查，只通知 B 站的页面", async () => {
  const fake = createFakeChrome({ manifest: { content_scripts: TEMPLATE.content_scripts }, local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, urlTabs: PAGES, matchUrlTabs: true });
  const app = createApp(fake.deps());
  assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope: "all" } }, senders.options()), { ok: true, value: {} });
  assert.ok(await until(() => lostTabs(fake).length === 1));
  assert.deepEqual(lostTabs(fake), [5]);
});

test("从没确认过启用时清除全部数据：不按地址查标签页，也没有页面要通知", async () => {
  const fake = createFakeChrome({ manifest: { content_scripts: TEMPLATE.content_scripts }, openTabs: [5, 6] });
  const app = createApp(fake.deps());
  assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope: "all" } }, senders.options()), { ok: true, value: {} });
  assert.deepEqual(fake.calls.tabQueries, []);
  assert.deepEqual(lostTabs(fake), []);
});

test("只清缓存或笔记：启用不受影响，不查标签页、不通知", async () => {
  const fake = createFakeChrome({ manifest: { content_scripts: TEMPLATE.content_scripts }, local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, openTabs: [5, 6] });
  const app = createApp(fake.deps());
  for (const scope of ["cache", "notes"] as const) assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope } }, senders.options()), { ok: true, value: {} });
  assert.deepEqual(fake.calls.tabQueries, []);
  assert.deepEqual(lostTabs(fake), []);
});

test("从没确认、原本就过期、确认没变的设置变化都不算启用失效", () => {
  const dropped = (oldValue: unknown, newValue: unknown, area = "local") => activationDropped({ [SETTINGS_STORAGE_KEY]: { oldValue, newValue } }, area);
  assert.equal(dropped(CONFIRMED, {}), true);
  assert.equal(dropped(CONFIRMED, undefined), true);
  assert.equal(dropped({}, {}), false);
  assert.equal(dropped(STALE_CONFIRMATION, {}), false);
  assert.equal(dropped(CONFIRMED, { ...CONFIRMED, accentTheme: "ochre" }), false);
  assert.equal(dropped(CONFIRMED, {}, "session"), false);
});
