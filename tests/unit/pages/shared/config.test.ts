// 页面的配置检查：启用以后才问；设置、会话里的密钥、记住的密钥变了，去抖后只问一次，只换密钥不用刷新；
// 存储变化只看键名、不读新旧值；途中又变了旧回答作废；回到没启用就清空；停止以后不再问。
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "@preact/signals";
import { createPageApi } from "../../../../src/pages/shared/api.ts";
import { CONFIG_DEBOUNCE_MS, CONFIG_KEYS, createConfigWatch, touchesConfig } from "../../../../src/pages/shared/config.ts";
import { API_KEY_LOCAL_KEY, API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY, TRIAGE_STORAGE_KEY, WATCH_SESSIONS_KEY } from "../../../../src/shared/names.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { fakeRuntime } from "../../../helpers/fake-runtime.ts";
import { manualTimers } from "../../../helpers/manual-timers.ts";
import { until } from "../../../helpers/wait-until.ts";

type StorageListener = (changes: object, area: string) => void;

const READY = { ok: true, value: { ready: true, errors: [] } };
const MISSING_KEY = { ok: true, value: { ready: false, errors: ["还没填 API 密钥。"] } };

function setup({ enabled = true } = {}) {
  const fake = fakeRuntime();
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  const listeners = new Set<StorageListener>();
  const timers = manualTimers();
  const on = signal(enabled);
  fake.reply("config.check", { value: READY });
  const watch = createConfigWatch({
    api,
    enabled: on,
    storageChanged: { addListener: (listener) => void listeners.add(listener), removeListener: (listener) => void listeners.delete(listener) },
    timers,
  });
  const change = (keys: readonly string[], area = "local"): void => {
    const changes = Object.fromEntries(keys.map((key) => [key, { newValue: "新", oldValue: "旧" }]));
    for (const listener of [...listeners]) listener(changes, area);
  };
  return { fake, watch, on, timers, change, listeners };
}

test("启用以后才问配置；没启用时存储怎么变都不发请求，回到没启用就清空", async () => {
  const { fake, watch, on, timers, change } = setup({ enabled: false });
  change([API_KEY_SESSION_KEY]);
  await watch.check();
  assert.equal(timers.pending(), 0);
  assert.equal(fake.attempts("config.check"), 0, "没启用时后台本来也不放行，页面就不发");
  assert.deepEqual(watch.state.value, { state: "unknown" });

  on.value = true;
  assert.ok(await until(() => watch.state.value.state === "checked"));
  assert.equal(fake.attempts("config.check"), 1);
  assert.deepEqual(watch.state.value, { state: "checked", view: READY.value });

  on.value = false;
  assert.deepEqual(watch.state.value, { state: "unknown" });
  change([SETTINGS_STORAGE_KEY]);
  assert.equal(timers.pending(), 0);
});

test("只换密钥不用刷新：设置、会话里的密钥、记住的密钥变了，去抖后只问一次；别的键变了不问", async () => {
  const { fake, watch, timers, change } = setup();
  assert.ok(await until(() => watch.state.value.state === "checked"));
  assert.equal(fake.attempts("config.check"), 1);

  change([WATCH_SESSIONS_KEY, TRIAGE_STORAGE_KEY]);
  assert.equal(timers.pending(), 0, "和配置无关的键不理");

  fake.reply("config.check", { value: MISSING_KEY });
  change([API_KEY_SESSION_KEY], "session");
  change([SETTINGS_STORAGE_KEY]);
  change([API_KEY_LOCAL_KEY]);
  assert.equal(timers.pending(), 1, "接连几次变化只排一次");
  assert.equal(fake.attempts("config.check"), 1, "去抖期间不问");
  timers.advance(CONFIG_DEBOUNCE_MS);
  assert.ok(await until(() => fake.attempts("config.check") === 2));
  assert.ok(await until(() => watch.state.value.state === "checked" && !watch.state.value.view.ready));
  assert.deepEqual([...CONFIG_KEYS].sort(), [API_KEY_LOCAL_KEY, API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY].sort());
});

test("存储变化只看键名，不读新旧值：密钥不经过页面", async () => {
  const { watch, timers, listeners } = setup();
  assert.ok(await until(() => watch.state.value.state === "checked"));
  const reads: string[] = [];
  const watched = (key: string) => ({
    get newValue() {
      reads.push(`${key} 新值`);
      return "自造的新密钥";
    },
    get oldValue() {
      reads.push(`${key} 旧值`);
      return "自造的旧密钥";
    },
  });
  const changes = Object.fromEntries([API_KEY_SESSION_KEY, API_KEY_LOCAL_KEY, SETTINGS_STORAGE_KEY, WATCH_SESSIONS_KEY].map((key) => [key, watched(key)]));
  assert.equal(touchesConfig(changes), true);
  for (const listener of [...listeners]) listener(changes, "session");
  assert.equal(timers.pending(), 1);
  assert.deepEqual(reads, [], "一个值都没读");
  assert.equal(touchesConfig({ [WATCH_SESSIONS_KEY]: watched(WATCH_SESSIONS_KEY) }), false);
  assert.deepEqual(reads, []);
});

test("问的途中又变了：先发的那次回答作废，以后问的为准", async () => {
  const { fake, watch, timers, change } = setup();
  assert.ok(await until(() => watch.state.value.state === "checked"));
  const slow = deferred();
  fake.reply("config.check", async (_req, attempt) => {
    if (attempt === 2) {
      await slow.promise;
      return READY;
    }
    return MISSING_KEY;
  });
  change([API_KEY_SESSION_KEY], "session");
  timers.advance(CONFIG_DEBOUNCE_MS);
  assert.ok(await until(() => fake.attempts("config.check") === 2));
  await watch.check();
  assert.equal(fake.attempts("config.check"), 3);
  slow.resolve();
  await nextTurn();
  assert.deepEqual(watch.state.value, { state: "checked", view: MISSING_KEY.value }, "慢的那次不盖回去");
});

test("问配置失败：记下失败的原因", async () => {
  const { fake, watch } = setup();
  assert.ok(await until(() => watch.state.value.state === "checked"));
  fake.reply("config.check", { value: { ok: false, code: "BACKGROUND_FAILED" } });
  await watch.check();
  assert.deepEqual(watch.state.value, { state: "failed", failure: { ok: false, code: "BACKGROUND_FAILED" } });
});

test("停止以后不再问：撤掉存储监听，排着的那次也取消", async () => {
  const { fake, watch, timers, change, listeners, on } = setup();
  assert.ok(await until(() => watch.state.value.state === "checked"));
  change([SETTINGS_STORAGE_KEY]);
  assert.equal(timers.pending(), 1);
  watch.stop();
  assert.equal(timers.pending(), 0);
  assert.equal(listeners.size, 0);
  on.value = false;
  on.value = true;
  await watch.check();
  await nextTurn();
  assert.equal(fake.attempts("config.check"), 1);
});
