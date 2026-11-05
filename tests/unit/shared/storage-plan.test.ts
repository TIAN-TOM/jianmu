import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClearScope } from "../../../src/core/clear-guard.ts";
import { STORAGE_KEYS, STORE_NAMES } from "../../../src/shared/names.ts";
import { clearTargets, STORAGE_PLAN, type Plan } from "../../../src/shared/storage-plan.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

// 定稿的清除表逐行抄在这里，不从实现里读：两边各写一份，改了哪一边都要对上才算核对过。
const ROWS: readonly (readonly [string, Plan])[] = [
  ["notes", { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: true }],
  ["overviews", { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: true }],
  ["qa", { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: true }],
  ["translations", { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: false }],
  ["imports", { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: false }],
  ["channels", { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: false }],
  ["cache", { area: "indexeddb", clearCache: "clear", clearAll: "clear", backup: false }],
  ["jianmu_triage", { area: "local", clearCache: "clear", clearAll: "clear", backup: false }],
  ["jianmu_model_caps", { area: "local", clearCache: "clear", clearAll: "clear", backup: false }],
  ["jianmu_relaxed_params", { area: "session", clearCache: "clear", clearAll: "clear", backup: false }],
  ["jianmu_settings", { area: "local", clearCache: "keep", clearAll: "clear", backup: false }],
  ["jianmu_api_key", { area: "session", clearCache: "keep", clearAll: "clear", backup: false }],
  ["jianmu_api_key_local", { area: "local", clearCache: "keep", clearAll: "clear", backup: false }],
  ["jianmu_watch_sessions", { area: "session", clearCache: "keep", clearAll: "clear", backup: false }],
  ["jianmu_auto_ledger", { area: "session", clearCache: "keep", clearAll: "clear", backup: false }],
  ["jianmu_settings_revision", { area: "local", clearCache: "keep", clearAll: "renew", backup: false }],
  ["jianmu_appearance", { area: "localStorage", clearCache: "keep", clearAll: "page-default", backup: false }],
];

function seeded() {
  return {
    stores: new Set<string>(["notes", "overviews", "qa", "cache", "translations", "imports", "channels"]),
    local: memoryStorage({
      jianmu_settings: { accent: "ochre" },
      jianmu_triage: { items: [] },
      jianmu_model_caps: { models: {} },
      jianmu_api_key_local: { version: 1, key: "test-key" },
      jianmu_settings_revision: "revision-old",
    }),
    session: memoryStorage({
      jianmu_api_key: { key: "test-key" },
      jianmu_relaxed_params: { someModel: { temperature: false } },
      jianmu_auto_ledger: { attempts: 1 },
      jianmu_watch_sessions: { 7: { mode: "skim" } },
    }),
  };
}

async function runClear(world: ReturnType<typeof seeded>, scope: ClearScope) {
  const targets = clearTargets(scope);
  for (const name of targets.stores) world.stores.delete(name);
  await world.local.remove(targets.local);
  await world.session.remove(targets.session);
  return targets;
}

test("清除缓存：只清字幕缓存、粗筛、模型能力和放宽记录，笔记、概览、问答、设置和密钥都在", async () => {
  const world = seeded();
  const targets = await runClear(world, "cache");

  assert.deepEqual([...world.stores], ["notes", "overviews", "qa", "translations", "imports", "channels"]);
  assert.deepEqual(Object.keys(world.local.data).sort(), [
    "jianmu_api_key_local",
    "jianmu_settings",
    "jianmu_settings_revision",
  ]);
  assert.deepEqual(Object.keys(world.session.data).sort(), [
    "jianmu_api_key",
    "jianmu_auto_ledger",
    "jianmu_watch_sessions",
  ]);
  assert.deepEqual(world.local.data["jianmu_settings"], { accent: "ochre" });
  assert.deepEqual(targets.renew, [], "清除缓存不换修订号");
});

test("清除全部数据：每个仓库、storage.local 和会话存储一个不留", async () => {
  const world = seeded();
  const targets = await runClear(world, "all");

  assert.deepEqual([...world.stores], []);
  assert.deepEqual(world.local.data, {});
  assert.deepEqual(world.session.data, {});

  // 清完只留下新的修订号，清除之前打开的表单核对不过，写不回去。
  assert.deepEqual(targets.renew, ["jianmu_settings_revision"]);
  for (const key of targets.renew) await world.local.set({ [key]: "revision-new" });
  assert.deepEqual(world.local.data, { jianmu_settings_revision: "revision-new" });
});

test("清除表逐项核对：每个仓库和键的放处、两种清除和备份都对得上", () => {
  assert.deepEqual(Object.keys(STORAGE_PLAN).sort(), ROWS.map(([name]) => name).sort());
  const plans: Readonly<Record<string, Plan>> = STORAGE_PLAN;
  for (const [name, plan] of ROWS) assert.deepEqual(plans[name], plan, name);
});

test("仓库和键全部登记，键都带扩展自己的前缀", () => {
  const registered = [...STORE_NAMES, ...STORAGE_KEYS];
  assert.equal(new Set(registered).size, registered.length, "名字不能重复");
  assert.deepEqual(registered.slice().sort(), Object.keys(STORAGE_PLAN).sort());
  for (const key of STORAGE_KEYS) assert.match(key, /^jianmu_/);
});

test("进备份的只有笔记、概览、问答", () => {
  const backedUp = Object.entries(STORAGE_PLAN).flatMap(([name, plan]) => (plan.backup ? [name] : []));
  assert.deepEqual(backedUp.sort(), ["notes", "overviews", "qa"]);
});

test("清除全部数据不动 localStorage：外观缓存由页面按默认值重写", () => {
  const targets = clearTargets("all");
  assert.equal(STORAGE_PLAN.jianmu_appearance.clearAll, "page-default");
  assert.equal(targets.local.includes("jianmu_appearance"), false);
  assert.equal(targets.session.includes("jianmu_appearance"), false);
});
