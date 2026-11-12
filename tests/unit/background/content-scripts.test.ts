// 后台和真实清单里的内容脚本：确认启用时按清单模板补注入 B 站内容脚本；启用失效（清除全部数据）时，
// 只按编号通知发过消息的内容脚本撤下界面，不再按地址查标签页；从没确认过时设置怎么变都不通知。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { activationDropped } from "../../../src/background/routes/activation.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION } from "../../helpers/chrome.ts";

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

test("从没确认、原本就过期、确认没变的设置变化都不算启用失效", () => {
  const dropped = (oldValue: unknown, newValue: unknown, area = "local") => activationDropped({ [SETTINGS_STORAGE_KEY]: { oldValue, newValue } }, area);
  assert.equal(dropped(CONFIRMED, {}), true);
  assert.equal(dropped(CONFIRMED, undefined), true);
  assert.equal(dropped({}, {}), false);
  assert.equal(dropped(STALE_CONFIRMATION, {}), false);
  assert.equal(dropped(CONFIRMED, { ...CONFIRMED, accentTheme: "ochre" }), false);
  assert.equal(dropped(CONFIRMED, {}, "session"), false);
});
