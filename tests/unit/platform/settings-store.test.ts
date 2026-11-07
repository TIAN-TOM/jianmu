// 设置的读写：密钥只在会话存储、写入排队、读不到写到一半的状态、启用确认的读写和失效。
// 后台路由不在这一层，带密钥的请求用真实的传输层守到发出之前。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiTransport } from "../../../src/core/ai/transport/index.ts";
import type { AiFetchInit, TransportError } from "../../../src/core/ai/transport/index.ts";
import { ACTIVATION_FINGERPRINT, ACTIVATION_VERSION } from "../../../src/core/consent.ts";
import { createLocks, type LockManagerLike } from "../../../src/platform/locks.ts";
import { createSettingsStore, type SettingsStore } from "../../../src/platform/settings-store.ts";
import type { ExtensionStorage } from "../../../src/platform/storage.ts";
import { API_KEY_SESSION_KEY, SETTINGS_LOCK_NAME, SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import {
  activationStatus,
  DATA_CONSENT_CONFIRMED,
  settingsRules,
  validate,
} from "../../../src/shared/settings-schema.ts";
import { clearTargets } from "../../../src/shared/storage-plan.ts";
import { deferred, nextTurn } from "../../helpers/deferred.ts";
import { memoryStorage, type MemoryStorage } from "../../helpers/memory-storage.ts";

const KEY_ERROR = "请填写 API 密钥（浏览器重启、扩展更新后要重新填）。";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com/";
const OPENAI_KEY = "sk-openai-secret";
const DEEPSEEK = { presetId: "deepseek", aiModel: "deepseek-v4-flash", ...DATA_CONSENT_CONFIRMED };
const ANTHROPIC_NEW = {
  presetId: "anthropic",
  aiModel: "claude-sonnet-5-5",
  aiApiKey: "sk-ant-new",
  ...DATA_CONSENT_CONFIRMED,
};
// 正常写不出这样的记录，用来确认本机设置里的密钥字段不算数。
const WITH_STRAY_KEY = { ...DEEPSEEK, aiApiKey: "sk-stray", aiApiKeyOrigin: DEEPSEEK_ORIGIN };

interface Areas {
  readonly local: MemoryStorage;
  readonly session: MemoryStorage;
}

function areas(local: Record<string, unknown> = {}, session: Record<string, unknown> = {}): Areas {
  return { local: memoryStorage(local), session: memoryStorage(session) };
}

const storeOn = (storage: ExtensionStorage, locks = createLocks()): SettingsStore =>
  createSettingsStore({ storage, locks });

/** 本机存储写满的样子。 */
const writesFail = (world: Areas): ExtensionStorage => ({
  ...world,
  local: {
    ...world.local,
    async set() {
      throw new Error("QUOTA_BYTES quota exceeded");
    },
  },
});

const savedSettings = ({ local }: Areas) => local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>;

function assertNoKeyFields(settings: Record<string, unknown>): void {
  assert.equal(Object.hasOwn(settings, "aiApiKey"), false);
  assert.equal(Object.hasOwn(settings, "aiApiKeyOrigin"), false);
}

/** 把第 holdRead 次读本机存储停在读到快照之后、交回之前。 */
function holdLocalRead(area: MemoryStorage, holdRead: number) {
  const reading = deferred();
  const released = deferred();
  let reads = 0;
  const local: MemoryStorage = {
    ...area,
    async get(key) {
      // 先记下这是第几次读：两次读取可能都在 await 之前进来。
      const readNo = ++reads;
      const snapshot = await area.get(key);
      if (readNo === holdRead) {
        reading.resolve();
        await released.promise;
      }
      return snapshot;
    },
  };
  return { local, reading: reading.promise, release: released.resolve };
}

/** 记下每次要锁的名字和模式，真正排队的还是 Web Locks。 */
function recordingLocks(onRequest: (count: number) => void = () => {}) {
  const requests: { readonly name: string; readonly mode: string }[] = [];
  const manager: LockManagerLike = {
    request(name, options, work) {
      requests.push({ name, mode: options.mode });
      onRequest(requests.length);
      return navigator.locks.request(name, options, work);
    },
  };
  return { locks: createLocks(manager), requests };
}

function transportOn(store: SettingsStore) {
  const sent: { readonly url: string; readonly init: AiFetchInit }[] = [];
  const transport = createAiTransport({
    getSettings: store.load,
    ensureHostPermission: async () => {},
    settingsRules,
    async fetch(url, init) {
      sent.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: "解释" } }] }),
      };
    },
  });
  const ask = () => transport.requestAiCompletion({ messages: [{ role: "user", content: "词" }], maxTokens: 64 });
  return { ask, sent };
}

const failureOf = (pending: Promise<unknown>): Promise<TransportError> =>
  pending.then(
    () => assert.fail("应当报错"),
    (error: TransportError) => error,
  );

// ============================================================
// 密钥只在会话存储
// ============================================================

test("保存时密钥只进会话存储，storage.local 里没有密钥字段", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" });

  const local = savedSettings(world);
  assertNoKeyFields(local);
  assert.equal(local["presetId"], "deepseek");
  assert.doesNotMatch(JSON.stringify(world.local.data), /sk-ds/);
  assert.deepEqual(world.session.data[API_KEY_SESSION_KEY], { key: "sk-ds", origin: DEEPSEEK_ORIGIN });

  const loaded = await store.load();
  assert.equal(loaded.aiApiKey, "sk-ds");
  assert.equal(validate(loaded).ok, true);
});

test("storage.local 写不进去（存储写满）：保存失败，会话里的旧密钥也不被新密钥换掉", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" });

  await assert.rejects(storeOn(writesFail(world)).save(ANTHROPIC_NEW), /QUOTA_BYTES/);

  const loaded = await storeOn(world).load();
  assert.equal(loaded.presetId, "deepseek");
  assert.equal(loaded.aiApiKey, "sk-old");
});

test("保存空密钥就删掉会话里的密钥", async () => {
  const world = areas({}, { [API_KEY_SESSION_KEY]: { key: "sk-ds", origin: DEEPSEEK_ORIGIN } });
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "" });
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false);
  assert.equal((await store.load()).aiApiKey, "");
});

test("第一次保存就写不进去：回滚时会话里不留新密钥", async () => {
  const world = areas();
  await assert.rejects(storeOn(writesFail(world)).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }), /QUOTA_BYTES/);
  assert.deepEqual(world.session.data, {});
});

test("会话清空以后（浏览器重启、扩展更新）其余设置还在，密钥要重填", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", accentTheme: "ochre" });

  const restarted = storeOn({ local: world.local, session: memoryStorage() });
  const loaded = await restarted.load();
  assert.equal(loaded.presetId, "deepseek");
  assert.equal(loaded.accentTheme, "ochre");
  assert.equal(loaded.aiApiKey, "");
  assert.deepEqual(validate(loaded).errors, [KEY_ERROR], "数据说明的确认留着，只差密钥");
});

test("改外观这类即改即存的设置，不会把旧密钥写回 storage.local", async () => {
  const world = areas(
    { [SETTINGS_STORAGE_KEY]: WITH_STRAY_KEY },
    { [API_KEY_SESSION_KEY]: { key: "sk-ds", origin: DEEPSEEK_ORIGIN } },
  );
  await storeOn(world).update({ accentTheme: "graphite" });

  const local = savedSettings(world);
  assert.equal(local["accentTheme"], "graphite");
  assertNoKeyFields(local);
  assert.deepEqual(world.session.data[API_KEY_SESSION_KEY], { key: "sk-ds", origin: DEEPSEEK_ORIGIN });
});

test("本机设置里多出来的密钥不认也不迁移：读到的是空的，下次写入时消失", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: WITH_STRAY_KEY });
  const store = storeOn(world);

  assert.equal((await store.load()).aiApiKey, "");
  assert.deepEqual(world.session.data, {});

  await store.update({ accentTheme: "ochre" });
  assertNoKeyFields(savedSettings(world));
  assert.deepEqual(world.session.data, {});
});

test("换了服务商，会话里属于旧地址的密钥丢弃", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" });

  const updated = await store.update({ presetId: "anthropic", aiModel: "claude-sonnet-5-5" });

  assert.equal(updated.aiApiKey, "");
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false);
});

test("会话里的记录形状不对时按没填", async () => {
  const records = [
    "sk-text",
    { key: 42, origin: DEEPSEEK_ORIGIN },
    { aiApiKey: "sk-other-shape" },
    { key: "sk" },
    { key: "sk", origin: "" },
    { key: "sk", origin: 42 },
  ];
  for (const record of records) {
    const world = areas({ [SETTINGS_STORAGE_KEY]: DEEPSEEK }, { [API_KEY_SESSION_KEY]: record });
    assert.equal((await storeOn(world).load()).aiApiKey, "", JSON.stringify(record));
  }
});

test("地址不合法时存下的密钥没有来源，换了服务商也不跟过去", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.save({
    presetId: "custom",
    aiBaseUrl: "http://typo.example.com",
    aiModel: "m",
    aiApiKey: "sk-typed-for-typo",
    ...DATA_CONSENT_CONFIRMED,
  });

  const moved = await store.update({ presetId: "deepseek", aiModel: "deepseek-v4-flash" });

  assert.equal(moved.aiApiKey, "");
  assert.deepEqual(validate(moved).errors, [KEY_ERROR]);
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false);
});

test("后台只认会话里的密钥：会话清空后报没设置好", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: WITH_STRAY_KEY });
  const store = storeOn(world);
  const { ask, sent } = transportOn(store);

  assert.deepEqual(validate(await store.load()).errors, [KEY_ERROR]);
  assert.equal((await failureOf(ask())).code, "NO_AI_CONFIG");
  assert.deepEqual(sent, []);
});

test("存储里的密钥属于别家时，后台请求不带它出门", async () => {
  const world = areas(
    { [SETTINGS_STORAGE_KEY]: DEEPSEEK },
    { [API_KEY_SESSION_KEY]: { key: OPENAI_KEY, origin: "https://api.openai.com/" } },
  );
  const { ask, sent } = transportOn(storeOn(world));

  assert.equal((await failureOf(ask())).code, "NO_AI_CONFIG");
  assert.deepEqual(sent, [], "密钥对不上来源时根本不该发请求");
});

test("密钥属于当前地址时后台照常带上", async () => {
  const world = areas(
    { [SETTINGS_STORAGE_KEY]: DEEPSEEK },
    { [API_KEY_SESSION_KEY]: { key: "sk-deepseek", origin: DEEPSEEK_ORIGIN } },
  );
  const { ask, sent } = transportOn(storeOn(world));

  assert.equal((await ask()).text, "解释");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, "https://api.deepseek.com/chat/completions");
  assert.equal((sent[0]?.init.headers as Record<string, string>)["Authorization"], "Bearer sk-deepseek");
});

test("设置只存在 SETTINGS_STORAGE_KEY 这一个键下", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" });

  assert.equal(SETTINGS_STORAGE_KEY, "jianmu_settings");
  assert.deepEqual(Object.keys(world.local.data), [SETTINGS_STORAGE_KEY]);
  assert.equal((await storeOn(world).load()).aiApiKey, "sk-ds");
});

// ============================================================
// 写入排队
// ============================================================

test("两个设置页同时保存：先保存的写 storage.local 失败、回滚密钥，不冲掉后保存成功的新密钥", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" });
  const firstWriting = deferred();
  const failFirst = deferred();
  let localWrites = 0;
  const storage: ExtensionStorage = {
    ...world,
    local: {
      ...world.local,
      async set(entries) {
        localWrites += 1;
        if (localWrites === 1) {
          firstWriting.resolve();
          await failFirst.promise;
          throw new Error("QUOTA_BYTES quota exceeded");
        }
        return world.local.set(entries);
      },
    },
  };

  // 第一个页面换成 Moonshot，写本机存储卡住、随后失败。
  const first = storeOn(storage).save({ presetId: "moonshot", aiApiKey: "sk-moon", ...DATA_CONSENT_CONFIRMED });
  // 卡住的时候第二个页面换成 Anthropic 并保存。
  const second = storeOn(storage).save(ANTHROPIC_NEW);
  await Promise.race([firstWriting.promise, second.catch(() => {})]);
  failFirst.resolve();
  await assert.rejects(first, /QUOTA_BYTES/);
  await second;

  const loaded = await storeOn(world).load();
  assert.equal(loaded.presetId, "anthropic");
  assert.equal(loaded.aiApiKey, "sk-ant-new", "后保存成功的密钥还在，没被回滚换成旧的");
});

test("两个页面同时改不同的即改即存设置：两项都留下，不互相盖回旧值", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" });
  const held = holdLocalRead(world.local, 1);
  const storage = { ...world, local: held.local };

  const theme = storeOn(storage).update({ accentTheme: "ochre" });
  const card = storeOn(storage).update({ inPageCard: false });
  await held.reading;
  held.release();
  await Promise.all([theme, card]);

  const loaded = await storeOn(world).load();
  assert.equal(loaded.accentTheme, "ochre");
  assert.equal(loaded.inPageCard, false);
});

test("有 Web Locks 时保存和改设置都在同一把锁里做", async () => {
  const world = areas();
  const { locks, requests } = recordingLocks();
  const store = storeOn(world, locks);

  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" });
  await store.update({ accentTheme: "ochre" });
  await store.confirmActivation();
  await store.clearAll();

  assert.deepEqual(requests, Array(4).fill({ name: SETTINGS_LOCK_NAME, mode: "exclusive" }));
});

test("读设置用共享锁：读和读不互相等，和写排同一把锁", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: DEEPSEEK });
  const { locks, requests } = recordingLocks();
  const store = storeOn(world, locks);

  await Promise.all([store.load(), store.activation()]);

  assert.deepEqual(requests, Array(2).fill({ name: SETTINGS_LOCK_NAME, mode: "shared" }));
});

test("保存写完密钥、还没写其余设置时读设置：等保存做完，读到的是完整的新设置", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" });
  const writingLocal = deferred();
  const releaseLocal = deferred();
  const storage: ExtensionStorage = {
    ...world,
    local: {
      ...world.local,
      async set(entries) {
        writingLocal.resolve();
        await releaseLocal.promise;
        return world.local.set(entries);
      },
    },
  };

  const saving = storeOn(storage).save(ANTHROPIC_NEW);
  await writingLocal.promise;
  const loading = storeOn(world).load();
  await nextTurn();
  releaseLocal.resolve();
  await saving;

  const loaded = await loading;
  assert.equal(loaded.presetId, "anthropic");
  assert.equal(loaded.aiApiKey, "sk-ant-new");
});

test("保存写完密钥、还没写其余设置时清除全部数据：保存整段做完才清，不会只剩设置、密钥却是空的", async () => {
  const world = areas();
  const releaseLocal = deferred();
  const savingLocal = deferred();
  // 放行保存的时机：清除已经在排队等设置锁，或者清除已经动手清存储。
  const { locks } = recordingLocks((count) => {
    if (count >= 2) releaseLocal.resolve();
  });
  let held = false;
  const storage: ExtensionStorage = {
    ...world,
    local: {
      ...world.local,
      async set(entries) {
        if (!held) {
          held = true;
          savingLocal.resolve();
          await releaseLocal.promise;
        }
        return world.local.set(entries);
      },
      async remove(keys) {
        releaseLocal.resolve();
        return world.local.remove(keys);
      },
    },
  };
  const store = storeOn(storage, locks);

  const saving = store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" });
  await savingLocal.promise;
  const clearing = store.clearAll();
  await saving;
  await clearing;

  assert.equal(Object.hasOwn(world.local.data, SETTINGS_STORAGE_KEY), false, "保存先做完，随后整段被清掉");
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false);
});

test("清除全部数据按清除表清两个存储区", async () => {
  const { local, session } = clearTargets("all");
  const world = areas(
    Object.fromEntries(local.map((key) => [key, "旧值"])),
    Object.fromEntries(session.map((key) => [key, "旧值"])),
  );

  await storeOn(world).clearAll();

  assert.deepEqual(world.local.data, {});
  assert.deepEqual(world.session.data, {});
});

// ============================================================
// 首次启用确认
// ============================================================

test("首次启用：没确认过时要给完整说明", async () => {
  const status = await storeOn(areas()).activation();
  assert.deepEqual(status, activationStatus({}));
  assert.equal(status.state, "needed");
  assert.equal(status.state === "needed" && status.updated, false);
});

test("点了启用后确认算数：记下版本和指纹，别的页面读到的也是已确认", async () => {
  const world = areas();
  await storeOn(world).confirmActivation();

  const local = savedSettings(world);
  assert.equal(local["activationVersion"], ACTIVATION_VERSION);
  assert.equal(local["activationFingerprint"], ACTIVATION_FINGERPRINT);
  assert.deepEqual(await storeOn(world).activation(), { state: "current" });
});

test("启用确认和数据同意分开记：确认启用不算同意，也不碰密钥和其余设置", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.save({ presetId: "deepseek", aiModel: "deepseek-v4-flash", aiApiKey: "sk-ds", accentTheme: "ochre" });

  const confirmed = await store.confirmActivation();

  assert.equal(confirmed.dataConsentVersion, 0);
  assert.equal(confirmed.aiApiKey, "sk-ds");
  assert.equal(confirmed.accentTheme, "ochre");
  assert.deepEqual(world.session.data[API_KEY_SESSION_KEY], { key: "sk-ds", origin: DEEPSEEK_ORIGIN });
  assertNoKeyFields(savedSettings(world));
});

test("同意了数据说明不算启用", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" });
  assert.equal((await storeOn(world).activation()).state, "needed");
});

test("说明的版本或指纹和当前不一致时确认失效，提示说明有更新", async () => {
  const stale = [
    { activationVersion: ACTIVATION_VERSION, activationFingerprint: "0000000000000000" },
    { activationVersion: ACTIVATION_VERSION + 1, activationFingerprint: ACTIVATION_FINGERPRINT },
  ];
  for (const stamp of stale) {
    const world = areas({ [SETTINGS_STORAGE_KEY]: stamp });
    const status = await storeOn(world).activation();
    assert.equal(status.state, "needed", JSON.stringify(stamp));
    assert.equal(status.state === "needed" && status.updated, true, "确认过别的版本");
  }
});

test("重新确认以后恢复：旧的版本和指纹换成当前的", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: { activationVersion: 1, activationFingerprint: "0000000000000000" } });
  const store = storeOn(world);

  await store.confirmActivation();

  assert.deepEqual(await store.activation(), { state: "current" });
});

test("清除全部数据后确认失效，当作从没确认过，重新确认后恢复", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.confirmActivation();

  await store.clearAll();

  const status = await store.activation();
  assert.equal(status.state, "needed");
  assert.equal(status.state === "needed" && status.updated, false, "不提示说明有更新");

  await store.confirmActivation();
  assert.deepEqual(await store.activation(), { state: "current" });
});

test("清除之前打开的表单写不回启用确认：保存和改设置都带不进去", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.confirmActivation();
  const staleForm = await store.load();
  await store.clearAll();

  await store.save(staleForm);
  assert.equal((await store.activation()).state, "needed");

  await store.update({ activationVersion: ACTIVATION_VERSION, activationFingerprint: ACTIVATION_FINGERPRINT });
  assert.equal((await store.activation()).state, "needed");
});

test("保存不带启用字段的表单不会抹掉确认", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.confirmActivation();

  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" });
  await store.update({ accentTheme: "ochre" });

  assert.deepEqual(await store.activation(), { state: "current" });
});
