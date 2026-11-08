// 设置的读写：密钥默认只在会话存储、记住密钥的本机记录、设置修订号、写入排队、读不到写到一半的状态、
// 启用确认的读写和失效。
// 后台路由不在这一层，带密钥的请求用真实的传输层守到发出之前。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAiTransport } from "../../../src/core/ai/transport/index.ts";
import type { AiFetchInit, TransportError } from "../../../src/core/ai/transport/index.ts";
import { ACTIVATION_FINGERPRINT, ACTIVATION_VERSION, DATA_CONSENT_ERROR } from "../../../src/core/consent.ts";
import { createLocks, type LockManagerLike } from "../../../src/platform/locks.ts";
import {
  createSettingsStore,
  isSettingsError,
  type LoadedSettings,
  type SettingsStore,
  type WrittenSettings,
} from "../../../src/platform/settings-store.ts";
import type { ExtensionStorage } from "../../../src/platform/storage.ts";
import {
  API_KEY_LOCAL_KEY,
  API_KEY_SESSION_KEY,
  SETTINGS_LOCK_NAME,
  SETTINGS_REVISION_KEY,
  SETTINGS_STORAGE_KEY,
} from "../../../src/shared/names.ts";
import {
  activationStatus,
  DATA_CONSENT_CONFIRMED,
  DEFAULTS,
  normalize,
  settingsRules,
  validate,
  type SettingsInput,
} from "../../../src/shared/settings-schema.ts";
import { clearTargets } from "../../../src/shared/storage-plan.ts";
import { deferred, nextTurn } from "../../helpers/deferred.ts";
import { memoryStorage, type MemoryStorage } from "../../helpers/memory-storage.ts";

const KEY_ERROR = "请填写 API 密钥（没选记住密钥时，浏览器重启、扩展更新后要重新填）。";
const DEEPSEEK_ORIGIN = "https://api.deepseek.com/";
const ANTHROPIC_ORIGIN = "https://api.anthropic.com/";
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
      throw new Error("Resource::kQuotaBytes quota exceeded");
    },
  },
});

/** 删除写不进去的样子。 */
const removeFails = (area: MemoryStorage): MemoryStorage => ({
  ...area,
  async remove() {
    throw new Error("IO error");
  },
});

const savedSettings = ({ local }: Areas) => local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>;

/** 全新安装时打开的表单：还没有修订号。 */
const NO_REVISION = "";

/** 存储里当前的修订号，相当于刚打开设置页时记下的那个。 */
function revisionOf({ local }: Areas): string {
  const revision = local.data[SETTINGS_REVISION_KEY];
  return typeof revision === "string" ? revision : NO_REVISION;
}

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
// 密钥默认只在会话存储
// ============================================================

test("没选记住时，保存的密钥只进会话存储，storage.local 里没有密钥字段", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);

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
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" }, NO_REVISION);

  await assert.rejects(storeOn(writesFail(world)).save(ANTHROPIC_NEW, revisionOf(world)), /quota exceeded/);

  const loaded = await storeOn(world).load();
  assert.equal(loaded.presetId, "deepseek");
  assert.equal(loaded.aiApiKey, "sk-old");
});

test("保存空密钥就删掉会话里的密钥", async () => {
  const world = areas({}, { [API_KEY_SESSION_KEY]: { key: "sk-ds", origin: DEEPSEEK_ORIGIN } });
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "" }, NO_REVISION);
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false);
  assert.equal((await store.load()).aiApiKey, "");
});

test("第一次保存就写不进去：回滚时会话里不留新密钥", async () => {
  const world = areas();
  await assert.rejects(storeOn(writesFail(world)).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION), /quota exceeded/);
  assert.deepEqual(world.session.data, {});
});

/** 会话存储写不进去、删不掉的样子：只坏一种操作，另一种照常。 */
function sessionFails(world: Areas, operation: "set" | "remove"): ExtensionStorage {
  return {
    ...world,
    session: {
      ...world.session,
      [operation]: async () => {
        throw new Error("IO error");
      },
    },
  };
}

test("会话写不进去：这次保存整次不动，设置、修订号、本机和会话里的密钥都和之前一样", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" }, NO_REVISION);
  const before = structuredClone({ local: world.local.data, session: world.session.data });

  await assert.rejects(storeOn(sessionFails(world, "set")).save(ANTHROPIC_NEW, revisionOf(world)), /IO error/);

  assert.deepEqual({ local: world.local.data, session: world.session.data }, before);
  const loaded = await storeOn(world).load();
  assert.equal(loaded.presetId, "deepseek");
  assert.equal(loaded.aiApiKey, "sk-old");
});

test("清除密钥时会话里那份删不掉：整次报错，设置不写，密钥也不会显示成已清除", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", accentTheme: "ochre" }, NO_REVISION);
  const settingsBefore = structuredClone(savedSettings(world));

  await assert.rejects(storeOn(sessionFails(world, "remove")).update({ aiApiKey: "" }), /IO error/);

  assert.deepEqual(savedSettings(world), settingsBefore, "设置没写进去");
  const loaded = await storeOn(world).load();
  assert.equal(loaded.aiApiKey, "sk-ds", "密钥还在，读到的就是它，不会以为已经清掉");
});

test("会话清空以后（浏览器重启、扩展更新）其余设置还在，密钥要重填", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", accentTheme: "ochre" }, NO_REVISION);

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
  await storeOn(world).update({ accentTheme: "graphite", themeMode: "dark", uiFontScale: 125, inPageCard: false });

  const local = savedSettings(world);
  assert.equal(local["accentTheme"], "graphite");
  assert.equal(local["themeMode"], "dark");
  assert.equal(local["uiFontScale"], 125);
  assert.equal(local["inPageCard"], false);
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
  const saved = await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);

  const updated = await store.save(
    { ...saved, presetId: "anthropic", aiModel: "claude-sonnet-5-5" },
    saved.settingsRevision,
  );

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
  await store.save(
    {
      presetId: "custom",
      aiBaseUrl: "http://typo.example.com",
      aiModel: "m",
      aiApiKey: "sk-typed-for-typo",
      ...DATA_CONSENT_CONFIRMED,
    },
    NO_REVISION,
  );

  const loaded = await store.load();
  const moved = await store.save(
    { ...loaded, presetId: "deepseek", aiModel: "deepseek-v4-flash" },
    loaded.settingsRevision,
  );

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
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);

  assert.equal(SETTINGS_STORAGE_KEY, "jianmu_settings");
  assert.deepEqual(Object.keys(world.local.data).sort(), [SETTINGS_STORAGE_KEY, SETTINGS_REVISION_KEY].sort());
  assert.equal(typeof world.local.data[SETTINGS_REVISION_KEY], "string", "另一个键只放修订号");
  assert.equal((await storeOn(world).load()).aiApiKey, "sk-ds");
});

// ============================================================
// 记住密钥
// ============================================================

/** 能限制本机存储访问的环境，记下每次申请。 */
function restrictable(local: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  const world = areas(local, session);
  const accessLevels: unknown[] = [];
  const area = {
    ...world.local,
    async setAccessLevel(options: unknown) {
      accessLevels.push(options);
    },
  };
  return { ...world, local: area, accessLevels };
}

/** 浏览器重启、扩展重新加载：会话存储清空，本机存储留着。 */
const restarted = ({ local }: Areas): ExtensionStorage => ({ local, session: memoryStorage() });

const contents = ({ local, session }: Areas) => structuredClone({ local: local.data, session: session.data });

const REMEMBERED_RECORD = { version: 1, key: "sk-ds", origin: DEEPSEEK_ORIGIN };

// 访问限制只挡内容脚本，报错不能写成只有扩展读得到：记住的密钥在磁盘上是原文。
const UNPROTECTED = {
  code: "REMEMBER_KEY_UNPROTECTED",
  message: "没能限制本机存储的访问范围，密钥没有记到这台电脑上。",
};

/** 访问限制申请不下来的环境。 */
function withRefusedAccess(world: Areas): ExtensionStorage {
  return {
    ...world,
    local: {
      ...world.local,
      async setAccessLevel() {
        throw new Error("Access level can only be set from a trusted context.");
      },
    },
  };
}

/** 已经勾上记住并保存，申请记录清空了。 */
async function remembered() {
  const world = restrictable();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey: true }, NO_REVISION);
  world.accessLevels.length = 0;
  return world;
}

test("默认不记住：没有这一项、或写成别的值，都按没选", () => {
  assert.equal(DEFAULTS.rememberApiKey, false);
  assert.equal(normalize({}).rememberApiKey, false);
  for (const value of ["true", 1, {}, null]) {
    assert.equal(normalize({ rememberApiKey: value }).rememberApiKey, false, JSON.stringify(value));
  }
  assert.equal(normalize({ rememberApiKey: true }).rememberApiKey, true);
});

test("勾上记住并保存：密钥和来源存进本机那份，设置里没有密钥，会话里也不留；重启后还能用", async () => {
  const world = restrictable({}, { [API_KEY_SESSION_KEY]: { key: "sk-old", origin: DEEPSEEK_ORIGIN } });
  const saved = await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey: true }, NO_REVISION);

  assert.equal(saved.rememberApiKey, true);
  assert.deepEqual(world.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }], "写磁盘之前先限制访问");
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
  const local = savedSettings(world);
  assertNoKeyFields(local);
  assert.doesNotMatch(JSON.stringify(local), /sk-ds/);
  assert.equal(local["rememberApiKey"], true);
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false, "会话里那份删掉");

  const loaded = await storeOn(restarted(world)).load();
  assert.equal(loaded.aiApiKey, "sk-ds");
  assert.equal(loaded.rememberApiKey, true);
  assert.equal(validate(loaded).ok, true);
});

test("没法限制本机存储的访问：整次不存，原来只在会话里的密钥和设置都不动", async () => {
  const world = restrictable();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" }, NO_REVISION);
  const before = contents(world);
  const form = { ...DEEPSEEK, aiApiKey: "sk-new", rememberApiKey: true };
  const revision = revisionOf(world);

  await assert.rejects(storeOn(withRefusedAccess(world)).save(form, revision), UNPROTECTED);
  assert.deepEqual(contents(world), before);

  const { setAccessLevel: _missing, ...unsupported } = world.local;
  await assert.rejects(storeOn({ ...world, local: unsupported }).save(form, revision), UNPROTECTED);
  assert.deepEqual(contents(world), before, "浏览器不支持限制访问时也不记");
  assert.equal((await storeOn(world).load()).aiApiKey, "sk-old");
});

test("打开记住时 storage.local 写不进去：什么都没写进去，会话里的旧密钥照旧能用", async () => {
  const world = restrictable();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" }, NO_REVISION);

  const form = { ...DEEPSEEK, aiApiKey: "sk-new", rememberApiKey: true };
  await assert.rejects(storeOn(writesFail(world)).save(form, revisionOf(world)), /quota exceeded/);

  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  const loaded = await storeOn(world).load();
  assert.equal(loaded.rememberApiKey, false);
  assert.equal(loaded.aiApiKey, "sk-old");
});

test("取消记住：本机那份删掉，密钥挪回会话，本次会话照常能用，重启后要重填", async () => {
  const world = await remembered();
  const saved = await storeOn(world).update({ rememberApiKey: false });

  assert.equal(saved.rememberApiKey, false);
  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  assert.equal(savedSettings(world)["rememberApiKey"], false);
  assert.deepEqual(world.session.data[API_KEY_SESSION_KEY], { key: "sk-ds", origin: DEEPSEEK_ORIGIN });
  assert.equal((await storeOn(world).load()).aiApiKey, "sk-ds");
  assert.equal((await storeOn(restarted(world)).load()).aiApiKey, "");
});

test("取消记住时本机那份删不掉：整次报错，开关还开着，不会显示已关闭、磁盘上却还有密钥", async () => {
  const world = await remembered();
  const stuck = {
    ...world,
    local: {
      ...world.local,
      async remove() {
        throw new Error("IO error");
      },
    },
  };

  await assert.rejects(storeOn(stuck).update({ rememberApiKey: false }), /IO error/);

  assert.equal(savedSettings(world)["rememberApiKey"], true);
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
  const loaded = await storeOn(restarted(world)).load();
  assert.equal(loaded.rememberApiKey, true, "照旧是记住的状态");
  assert.equal(loaded.aiApiKey, "sk-ds");
});

test("取消记住时本机那份已删、开关没写进去：不把那份写回磁盘，密钥要重填", async () => {
  const world = await remembered();
  const full = {
    ...world,
    local: {
      ...world.local,
      async set(entries: Record<string, unknown>) {
        if (entries[SETTINGS_STORAGE_KEY]) throw new Error("Resource::kQuotaBytes quota exceeded");
        return world.local.set(entries);
      },
    },
  };

  await assert.rejects(storeOn(full).update({ rememberApiKey: false }), /quota exceeded/);

  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false, "删掉的不再恢复");
  assert.equal((await storeOn(world).load()).aiApiKey, "", "记住状态下只认本机那份，没有就当没填");
});

/**
 * 第 step 次改动存储时出错。interrupted 时之后的改动也都进不去，
 * 相当于后台中途被杀，失败之后的回滚也跑不了。
 */
function failsAtStep({ local, session, ...rest }: ReturnType<typeof restrictable>, step: number, interrupted: boolean) {
  let writes = 0;
  const counted =
    <Args extends unknown[]>(write: (...args: Args) => Promise<void>) =>
    async (...args: Args) => {
      writes += 1;
      if (writes === step || (interrupted && writes > step)) throw new Error("IO error");
      await write(...args);
    };
  const area = (target: MemoryStorage) => ({ ...target, set: counted(target.set), remove: counted(target.remove) });
  return { storage: { ...rest, local: area(local), session: area(session) }, writes: () => writes };
}

test("清掉密钥的每一步失败或中断：密钥已经没了的话，之前打开的表单写不回去", async () => {
  const sessionOnly = async () => {
    const world = restrictable();
    await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", ...DATA_CONSENT_CONFIRMED }, NO_REVISION);
    return world;
  };
  const clears: readonly [string, (store: SettingsStore, opened: LoadedSettings) => Promise<unknown>][] = [
    ["清除密钥", (store) => store.update({ aiApiKey: "" })],
    ["取消记住", (store) => store.update({ rememberApiKey: false })],
    ["保存时取消记住", (store, opened) => store.save({ ...opened, rememberApiKey: false }, opened.settingsRevision)],
    ["保存时清空密钥", (store, opened) => store.save({ ...opened, aiApiKey: "" }, opened.settingsRevision)],
    [
      "换服务商",
      (store, opened) =>
        store.save({ ...opened, ...ANTHROPIC_NEW, aiApiKey: "sk-ds", aiApiKeyOrigin: "" }, opened.settingsRevision),
    ],
    ["清除全部数据", (store) => store.clearAll()],
  ];

  for (const [name, clear] of clears) {
    for (const setup of [remembered, sessionOnly]) {
      for (const interrupted of [false, true]) {
        for (let step = 1; ; step += 1) {
          const label = `${name}，${setup === remembered ? "记住" : "没记住"}，第 ${step} 步${interrupted ? "中断" : "失败"}`;
          const world = await setup();
          const store = storeOn(world);
          const opened = await store.load();
          const hadRecord = Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY);
          const faulty = failsAtStep(world, step, interrupted);

          await clear(storeOn(faulty.storage), opened).catch(() => undefined);
          if (faulty.writes() < step) break;

          const recordGone = hadRecord && !Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY);
          const keyGone = (await store.load()).aiApiKey !== opened.aiApiKey;
          if (recordGone || keyGone) {
            await assert.rejects(store.save(opened, opened.settingsRevision), { code: "SETTINGS_STALE" }, label);
          }
        }
      }
    }
  }
});

test("没选记住、本机却留着一份（上次关开关中途失败）：读设置时不用它，并且删掉", async () => {
  const world = restrictable(
    {
      [SETTINGS_STORAGE_KEY]: { ...DEEPSEEK, rememberApiKey: false },
      [API_KEY_LOCAL_KEY]: { version: 1, key: "sk-leftover", origin: DEEPSEEK_ORIGIN },
    },
    { [API_KEY_SESSION_KEY]: { key: "sk-session", origin: DEEPSEEK_ORIGIN } },
  );

  const loaded = await storeOn(world).load();

  assert.equal(loaded.aiApiKey, "sk-session");
  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  assert.equal((await storeOn(restarted(world)).load()).aiApiKey, "", "重启后也不会冒出残留的那把");
});

test("没选记住、会话是空的、本机留着完整记录：不用它，读到的是空密钥，记录删掉", async () => {
  const world = restrictable({
    [SETTINGS_STORAGE_KEY]: { ...DEEPSEEK, rememberApiKey: false },
    [API_KEY_LOCAL_KEY]: REMEMBERED_RECORD,
  });

  assert.equal((await storeOn(world).load()).aiApiKey, "");
  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
});

test("选了记住时只认本机那份：会话里残留的另一把不用", async () => {
  const world = await remembered();
  world.session.data[API_KEY_SESSION_KEY] = { key: "sk-stale", origin: DEEPSEEK_ORIGIN };
  assert.equal((await storeOn(world).load()).aiApiKey, "sk-ds");
});

test("选了记住、本机记录缺失或版本不对：读到的是空密钥，不回落到会话里的另一把", async () => {
  const records = [{}, { [API_KEY_LOCAL_KEY]: { version: 2, key: "sk-future", origin: DEEPSEEK_ORIGIN } }];
  for (const record of records) {
    const world = areas(
      { [SETTINGS_STORAGE_KEY]: { ...DEEPSEEK, rememberApiKey: true }, ...record },
      { [API_KEY_SESSION_KEY]: { key: "sk-session", origin: DEEPSEEK_ORIGIN } },
    );
    assert.equal((await storeOn(world).load()).aiApiKey, "", JSON.stringify(record));
  }
});

test("本机那份缺来源或版本不对：当作没填，不绑到当前地址上", async () => {
  const records = [
    { version: 1, key: "sk-no-origin" },
    { version: 1, key: "sk-empty-origin", origin: "" },
    { version: 2, key: "sk-future", origin: DEEPSEEK_ORIGIN },
    { key: "sk-no-version", origin: DEEPSEEK_ORIGIN },
    { version: 1, key: "   ", origin: DEEPSEEK_ORIGIN },
    "sk-plain-string",
  ];
  for (const record of records) {
    const world = areas({
      [SETTINGS_STORAGE_KEY]: { ...DEEPSEEK, rememberApiKey: true },
      [API_KEY_LOCAL_KEY]: record,
    });
    assert.equal((await storeOn(world).load()).aiApiKey, "", JSON.stringify(record));
  }
});

test("本机那份格式不对也删得掉：读取、清除密钥、取消记住之后都不留在本机存储里", async () => {
  const records = [{ version: 2, key: "sk-future", origin: DEEPSEEK_ORIGIN }, "sk-plain-string"];
  const form = { ...DEEPSEEK, aiApiKey: "sk-new", rememberApiKey: false };
  const paths: readonly (readonly [string, boolean, (store: SettingsStore) => Promise<unknown>])[] = [
    ["开关关着时读取", false, (store) => store.load()],
    ["开关关着时清除密钥", false, (store) => store.update({ aiApiKey: "" })],
    ["开关关着时取消记住", false, (store) => store.update({ rememberApiKey: false })],
    ["开关开着时清除密钥", true, (store) => store.update({ aiApiKey: "" })],
    ["开关开着时取消记住", true, (store) => store.update({ rememberApiKey: false })],
    ["开关开着时表单取消记住", true, (store) => store.save(form, NO_REVISION)],
  ];
  for (const record of records) {
    for (const [path, rememberApiKey, act] of paths) {
      const world = areas({ [SETTINGS_STORAGE_KEY]: { ...DEEPSEEK, rememberApiKey }, [API_KEY_LOCAL_KEY]: record });

      await act(storeOn(world));

      const label = `${path}：${JSON.stringify(record)}`;
      assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false, label);
      assert.doesNotMatch(JSON.stringify(contents(world)), /sk-future|sk-plain-string/, label);
    }
  }
});

test("本机那份属于别的地址：换了服务商之后不发给新服务商", async () => {
  const world = areas({
    [SETTINGS_STORAGE_KEY]: { presetId: "anthropic", rememberApiKey: true, ...DATA_CONSENT_CONFIRMED },
    [API_KEY_LOCAL_KEY]: REMEMBERED_RECORD,
  });
  const { ask, sent } = transportOn(storeOn(world));

  assert.equal((await storeOn(world).load()).aiApiKey, "");
  assert.equal((await failureOf(ask())).code, "NO_AI_CONFIG");
  assert.deepEqual(sent, []);
});

test("清除密钥：会话里和本机的都删掉，记住开关跟着关", async () => {
  const world = await remembered();
  const saved = await storeOn(world).update({ aiApiKey: "" });

  assert.equal(saved.rememberApiKey, false);
  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  assert.equal(Object.hasOwn(world.session.data, API_KEY_SESSION_KEY), false);
  assert.equal(savedSettings(world)["rememberApiKey"], false);
  assert.equal((await storeOn(restarted(world)).load()).aiApiKey, "");
});

test("记住时改外观、开关卡片：不重写那份密钥，也不重新申请访问限制", async () => {
  const world = await remembered();
  const writes: string[][] = [];
  const watched = {
    ...world,
    local: {
      ...world.local,
      async set(entries: Record<string, unknown>) {
        writes.push(Object.keys(entries));
        return world.local.set(entries);
      },
    },
  };
  const store = storeOn(watched);

  await store.update({ accentTheme: "ochre" });
  await store.update({ inPageCard: false });

  assert.deepEqual(writes, [[SETTINGS_STORAGE_KEY], [SETTINGS_STORAGE_KEY]]);
  assert.deepEqual(world.accessLevels, []);
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
  assert.equal((await storeOn(restarted(world)).load()).accentTheme, "ochre");
});

test("记住时换密钥：重写本机记录，重新申请访问限制，修订号换新", async () => {
  const world = await remembered();
  const before = revisionOf(world);

  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds-2", rememberApiKey: true }, before);

  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], { ...REMEMBERED_RECORD, key: "sk-ds-2" });
  assert.deepEqual(world.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
  assert.notEqual(revisionOf(world), before);
});

test("记住时同一把密钥写明新来源换服务商：本机记录改绑，修订号换新", async () => {
  const world = await remembered();
  const before = revisionOf(world);

  const saved = await storeOn(world).save(
    { ...ANTHROPIC_NEW, aiApiKey: "sk-ds", aiApiKeyOrigin: ANTHROPIC_ORIGIN, rememberApiKey: true },
    before,
  );

  assert.equal(saved.aiApiKey, "sk-ds");
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], { ...REMEMBERED_RECORD, origin: ANTHROPIC_ORIGIN });
  assert.notEqual(revisionOf(world), before);
});

test("记住时换密钥、访问限制申请不下来：旧记录和设置原样", async () => {
  const world = await remembered();
  const before = contents(world);
  const form = { ...DEEPSEEK, aiApiKey: "sk-ds-2", rememberApiKey: true };

  await assert.rejects(storeOn(withRefusedAccess(world)).save(form, revisionOf(world)), UNPROTECTED);

  assert.deepEqual(contents(world), before);
});

test("打开记住时记录、开关和修订号一次写完：只有一次写入，三个键都在里面", async () => {
  const world = restrictable();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  const writes: string[][] = [];
  const watched = {
    ...world,
    local: {
      ...world.local,
      async set(entries: Record<string, unknown>) {
        writes.push(Object.keys(entries).sort());
        return world.local.set(entries);
      },
    },
  };

  await storeOn(watched).save({ ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey: true }, revisionOf(world));

  assert.deepEqual(writes, [[API_KEY_LOCAL_KEY, SETTINGS_STORAGE_KEY, SETTINGS_REVISION_KEY].sort()]);
});

test("记住和数据同意分开算：没同意也能记住，撤销同意不删记录，同意字段只由同意改", async () => {
  const world = restrictable();
  const store = storeOn(world);
  const saved = await store.save(
    { presetId: "deepseek", aiModel: "deepseek-v4-flash", aiApiKey: "sk-ds", rememberApiKey: true },
    NO_REVISION,
  );

  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
  assert.equal(saved.dataConsentVersion, 0);
  assert.deepEqual(validate(saved).errors, [DATA_CONSENT_ERROR]);

  await store.setDataConsent(true);
  await store.setDataConsent(false);
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
});

test("没选记住时改外观、开关卡片、改数据说明的确认：都不会把会话里的密钥写进磁盘", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);

  await store.update({ accentTheme: "ochre" });
  await store.update({ inPageCard: false });
  await store.setDataConsent(false);

  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  assert.doesNotMatch(JSON.stringify(world.local.data), /sk-ds/);
  assert.deepEqual(world.accessLevels, []);
});

test("只勾选、没保存：改设置和确认启用都打不开记住，密钥不写磁盘", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);

  // @ts-expect-error 打开记住只走 save
  const updated = await store.update({ rememberApiKey: true });
  await store.confirmActivation();
  const loaded = await store.load();

  for (const settings of [updated, loaded]) assert.equal(settings.rememberApiKey, false);
  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  assert.doesNotMatch(JSON.stringify(world.local.data), /sk-ds/);
  assert.deepEqual(world.accessLevels, []);
  assert.deepEqual(world.session.data[API_KEY_SESSION_KEY], { key: "sk-ds", origin: DEEPSEEK_ORIGIN });
});

test("改设置写不回密钥、来源和服务商：清除全部之后，过时页面的补丁不生效", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey: true }, NO_REVISION);
  await store.clearAll();

  // @ts-expect-error 写密钥只走 save
  const updated = await store.update({ aiApiKey: "sk-ds", aiApiKeyOrigin: DEEPSEEK_ORIGIN, presetId: "deepseek" });

  assert.equal(updated.aiApiKey, "");
  assert.equal(updated.presetId, DEFAULTS.presetId);
  assert.doesNotMatch(JSON.stringify(contents(world)), /sk-ds/);
});

test("过时的表单整份传给改设置：只有即改即存的字段算数，密钥和两种确认都带不进去", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  await store.confirmActivation();
  const stale = await store.load();
  await store.clearAll();

  // @ts-expect-error 整份表单走 save，那里核对修订号
  const updated = await store.update({ ...stale, themeMode: "dark" });

  assert.equal(updated.themeMode, "dark");
  assert.equal(updated.aiApiKey, "");
  assert.equal(updated.dataConsentVersion, 0);
  assert.equal(updated.activationVersion, 0);
  assert.doesNotMatch(JSON.stringify(contents(world)), /sk-ds/);
});

test("记住时改设置换不了密钥绑定的地址：本机记录原样，不重新申请访问限制", async () => {
  const world = await remembered();
  const store = storeOn(world);
  const evil = { presetId: "custom", aiBaseUrl: "https://evil.example/v1" };

  // @ts-expect-error 换地址走 save
  await store.update({ ...evil, aiApiKeyOrigin: "" });
  // @ts-expect-error 换地址走 save
  await store.update({ ...evil, aiApiKeyOrigin: "https://evil.example/" });

  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
  assert.equal(savedSettings(world)["presetId"], "deepseek");
  assert.equal(savedSettings(world)["rememberApiKey"], true);
  assert.deepEqual(world.accessLevels, []);
});

test("表单没写来源、密钥还是已存的那把：换了服务商不跟过去，记住的那份也删掉", async () => {
  const stored = ANTHROPIC_NEW.aiApiKey;
  for (const [rememberApiKey, aiApiKeyOrigin, aiApiKey] of [
    [false, undefined, stored],
    [true, undefined, stored],
    [true, "", stored],
    [true, 42, stored],
    // 输入框里带着空格，规整后还是已存的那把。
    [false, undefined, `${stored} `],
    [true, undefined, `  ${stored}\n`],
    [true, "", `${stored} `],
  ]) {
    const world = restrictable();
    const store = storeOn(world);
    await store.save({ ...ANTHROPIC_NEW, rememberApiKey }, NO_REVISION);

    const moved = { ...DEEPSEEK, aiApiKey, aiApiKeyOrigin, rememberApiKey };
    const saved = await store.save(moved, revisionOf(world));

    assert.equal(saved.aiApiKey, "");
    assert.equal(saved.rememberApiKey, false);
    assert.doesNotMatch(JSON.stringify(contents(world)), /sk-ant-new/);
  }
});

test("表单没写来源、地址没变：已存的那把照旧，不算改过，也不重写本机记录", async () => {
  const world = await remembered();
  const before = revisionOf(world);

  const saved = await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey: true }, before);

  assert.equal(saved.aiApiKey, "sk-ds");
  assert.equal(saved.aiApiKeyOrigin, DEEPSEEK_ORIGIN);
  assert.equal(revisionOf(world), before);
  assert.deepEqual(world.accessLevels, []);
});

test("表单没写来源、地址改成不合法的：记住的那把留着，来源不变", async () => {
  const world = await remembered();
  const typo = { presetId: "custom", aiBaseUrl: "http://typo.example.com", aiModel: "m", ...DATA_CONSENT_CONFIRMED };

  const saved = await storeOn(world).save({ ...typo, aiApiKey: "sk-ds", rememberApiKey: true }, revisionOf(world));

  assert.equal(saved.aiApiKey, "sk-ds");
  assert.equal(saved.aiApiKeyOrigin, DEEPSEEK_ORIGIN);
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
});

test("勾了记住但密钥没有所属来源：整次不存，也不申请访问限制", async () => {
  const world = restrictable();
  const before = contents(world);

  await assert.rejects(
    storeOn(world).save(
      {
        presetId: "custom",
        aiBaseUrl: "http://typo.example.com",
        aiModel: "m",
        aiApiKey: "sk-typed-for-typo",
        rememberApiKey: true,
      },
      NO_REVISION,
    ),
    { code: "REMEMBER_KEY_UNBOUND" },
  );

  assert.deepEqual(contents(world), before);
  assert.deepEqual(world.accessLevels, []);
});

test("勾了记住、地址不合法，表单写的来源不算数：整次不存，也不申请访问限制", async () => {
  const world = restrictable();
  const before = contents(world);

  await assert.rejects(
    storeOn(world).save(
      {
        presetId: "custom",
        aiBaseUrl: "http://typo.example.com",
        aiModel: "m",
        aiApiKey: "sk-typed-for-typo",
        aiApiKeyOrigin: ANTHROPIC_ORIGIN,
        rememberApiKey: true,
      },
      NO_REVISION,
    ),
    { code: "REMEMBER_KEY_UNBOUND" },
  );

  assert.deepEqual(contents(world), before);
  assert.deepEqual(world.accessLevels, []);
});

test("勾了记住却没填密钥：不记，开关跟着关", async () => {
  const world = restrictable();
  const saved = await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "", rememberApiKey: true }, NO_REVISION);

  assert.equal(saved.rememberApiKey, false);
  assert.equal(savedSettings(world)["rememberApiKey"], false);
  assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false);
  assert.deepEqual(world.accessLevels, []);
});

test("设置的三种报错都不带密钥：说明、调用栈、原因和序列化结果里都没有", async () => {
  const secret = "sk-SECRET-VALUE";
  const form = { ...DEEPSEEK, aiApiKey: secret, rememberApiKey: true };
  const typo = { presetId: "custom", aiBaseUrl: "http://typo.example.com", aiModel: "m", aiApiKey: secret };
  const unprotected = restrictable();
  const unbound = restrictable();
  const stale = restrictable();
  await storeOn(stale).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);

  const errors = await Promise.all([
    failureOf(storeOn(withRefusedAccess(unprotected)).save(form, NO_REVISION)),
    failureOf(storeOn(unbound).save({ ...typo, rememberApiKey: true }, NO_REVISION)),
    failureOf(storeOn(stale).save(form, NO_REVISION)),
  ]);

  assert.deepEqual(
    errors.map(({ code }) => code),
    ["REMEMBER_KEY_UNPROTECTED", "REMEMBER_KEY_UNBOUND", "SETTINGS_STALE"],
  );
  for (const error of errors) {
    const shown = [error.message, error.stack, String(error.cause), JSON.stringify(error)].join("\n");
    assert.equal(shown.includes(secret), false, String(error.code));
  }
});

test("isSettingsError 只认设置读写抛的三种码，别的错和伪造的对象不算", async () => {
  const stale = restrictable();
  await storeOn(stale).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  const error = await failureOf(storeOn(stale).save(DEEPSEEK, NO_REVISION));

  assert.equal(isSettingsError(error), true);
  assert.equal(isSettingsError(new Error("IO error")), false);
  assert.equal(isSettingsError(Object.assign(new Error("x"), { code: "NOT_A_SETTINGS_CODE" })), false);
  assert.equal(isSettingsError({ code: "SETTINGS_STALE", message: "不是异常" }), false);
});

test("不含密钥的读法：会话里和本机记录里的密钥都不带，本机设置里多出来的密钥字段也去掉", async () => {
  const sessionWorld = areas({ [SETTINGS_STORAGE_KEY]: WITH_STRAY_KEY }, { [API_KEY_SESSION_KEY]: { key: "sk-ds", origin: DEEPSEEK_ORIGIN } });
  const remembering = await remembered();

  for (const world of [sessionWorld, remembering]) {
    const publicSettings = await storeOn(world).loadPublic();
    assertNoKeyFields(publicSettings);
    assert.doesNotMatch(JSON.stringify(publicSettings), /sk-ds|sk-stray/);
    assert.equal(publicSettings.presetId, "deepseek");
  }
});

test("不含密钥的读法只读本机设置这一项，不碰会话和本机的密钥记录", async () => {
  const world = await remembered();
  const reads: unknown[] = [];
  const watched = (area: MemoryStorage): MemoryStorage => ({
    ...area,
    async get(key) {
      reads.push(key);
      return area.get(key);
    },
  });

  await storeOn({ local: watched(world.local), session: watched(world.session) }).loadPublic();

  assert.deepEqual(reads, [SETTINGS_STORAGE_KEY]);
});

// ============================================================
// 设置修订号
// ============================================================

test("设置修订号：换密钥、开关记住、改数据说明的确认时换新的，只改模型、外观时不变", async () => {
  const world = restrictable();
  const store = storeOn(world);
  const revisionNow = () => world.local.data[SETTINGS_REVISION_KEY];
  const resave = async (changes: SettingsInput) => {
    const loaded = await store.load();
    return store.save({ ...loaded, ...changes }, loaded.settingsRevision);
  };
  const reconfirmFrom = (stale: SettingsInput) => {
    world.local.data[SETTINGS_STORAGE_KEY] = { ...savedSettings(world), ...stale };
    return store.setDataConsent(true);
  };

  const first = await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  assert.ok(revisionNow());
  assert.equal(first.settingsRevision, revisionNow());
  assert.equal(Object.hasOwn(savedSettings(world), "settingsRevision"), false, "修订号不进设置");

  const steps: readonly (readonly [string, () => Promise<WrittenSettings>, boolean])[] = [
    ["改模型", () => resave({ aiModel: "deepseek-v4-pro" }), false],
    ["改外观", () => store.update({ accentTheme: "graphite" }), false],
    ["换密钥", () => resave({ aiApiKey: "sk-ds-2" }), true],
    ["换来源", () => resave({ presetId: "anthropic", aiApiKeyOrigin: ANTHROPIC_ORIGIN }), true],
    ["打开记住", () => resave({ rememberApiKey: true }), true],
    ["取消确认", () => store.setDataConsent(false), true],
    ["重新确认", () => store.setDataConsent(true), true],
    ["确认过的版本对不上", () => reconfirmFrom({ dataConsentVersion: DATA_CONSENT_CONFIRMED.dataConsentVersion + 1 }), true],
    ["确认过的指纹对不上", () => reconfirmFrom({ dataConsentFingerprint: "0000000000000000" }), true],
    ["关掉记住", () => store.update({ rememberApiKey: false }), true],
  ];
  for (const [label, step, changes] of steps) {
    const before = revisionNow();
    const saved = await step();
    assert.equal(revisionNow() !== before, changes, label);
    assert.equal(saved.settingsRevision, revisionNow(), label);
    assert.equal(saved.previousRevision, before, `${label}：写之前的修订号也带回来`);
  }
  assert.equal((await store.load()).settingsRevision, revisionNow());
});

test("表单打开之后别处换过修订号：整次不存（SETTINGS_STALE），什么都不写", async () => {
  const world = restrictable();
  const store = storeOn(world);
  const opened = await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  await store.update({ aiApiKey: "" });
  const before = contents(world);

  await assert.rejects(store.save({ ...opened, aiApiKey: "sk-ds", rememberApiKey: true }, opened.settingsRevision), {
    code: "SETTINGS_STALE",
  });

  assert.deepEqual(contents(world), before);
  assert.deepEqual(world.accessLevels, [], "也没去申请访问限制");
});

test("表单没带修订号：已经有修订号时按过时处理", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  const before = contents(world);

  // @ts-expect-error 修订号是必填参数
  await assert.rejects(store.save({ ...DEEPSEEK, aiApiKey: "sk-other" }), { code: "SETTINGS_STALE" });

  assert.deepEqual(contents(world), before);
});

test("清除全部数据之后，清除前打开的表单再保存：存不进去，密钥和数据说明的确认都不复活", async () => {
  for (const rememberApiKey of [false, true]) {
    const world = restrictable();
    const store = storeOn(world);
    await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey }, NO_REVISION);
    const form = await store.load();
    assert.equal(form.aiApiKey, "sk-ds");

    await store.clearAll();
    assert.equal(Object.hasOwn(world.local.data, API_KEY_LOCAL_KEY), false, "本机记住的那份也清掉");

    await assert.rejects(store.save(form, form.settingsRevision), { code: "SETTINGS_STALE" });
    const loaded = await store.load();
    assert.equal(loaded.aiApiKey, "");
    assert.equal(loaded.rememberApiKey, false);
    assert.equal(loaded.dataConsentVersion, 0);
    assert.equal(loaded.dataConsentFingerprint, "");
    assert.doesNotMatch(JSON.stringify(contents(world)), /sk-ds/);
  }
});

test("表单里带的修订号不算数，只看保存时传的那个：和最新设置合并过的旧表单一样存不回去", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save({ ...ANTHROPIC_NEW, rememberApiKey: true }, NO_REVISION);
  const opened = await store.load();
  const { presetId, aiApiKey, aiApiKeyOrigin, rememberApiKey } = opened;
  const fields = { presetId, aiApiKey, aiApiKeyOrigin, rememberApiKey, ...DATA_CONSENT_CONFIRMED };

  await store.clearAll();
  const cleared = contents(world);

  await assert.rejects(store.save({ ...(await store.load()), ...fields }, opened.settingsRevision), {
    code: "SETTINGS_STALE",
  });
  assert.deepEqual(contents(world), cleared);
});

test("清除全部数据之前还没有修订号时打开的表单：同样写不回去", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: DEEPSEEK });
  const store = storeOn(world);
  const form = await store.load();
  assert.equal(form.settingsRevision, "");

  await store.clearAll();

  await assert.rejects(store.save(form, form.settingsRevision), { code: "SETTINGS_STALE" });
  assert.equal((await store.load()).dataConsentVersion, 0);
});

test("新修订号和清除在同一把锁里写入：排在清除后面的保存看到的已经是新值", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: DEEPSEEK });
  const renewing = deferred();
  const release = deferred();
  const storage: ExtensionStorage = {
    ...world,
    local: {
      ...world.local,
      async set(entries) {
        if (Object.hasOwn(entries, SETTINGS_REVISION_KEY)) {
          renewing.resolve();
          await release.promise;
        }
        return world.local.set(entries);
      },
    },
  };
  const store = storeOn(storage);
  const form = await store.load();

  const clearing = store.clearAll();
  await renewing.promise;
  const saving = store.save({ ...form, aiApiKey: "sk-ds", ...DATA_CONSENT_CONFIRMED }, form.settingsRevision);
  await nextTurn();
  release.resolve();
  await clearing;

  await assert.rejects(saving, { code: "SETTINGS_STALE" });
  assert.equal((await storeOn(world).load()).aiApiKey, "");
});

test("每次清除全部数据都换一个新的修订号", async () => {
  const world = areas();
  const store = storeOn(world);

  await store.clearAll();
  const first = world.local.data[SETTINGS_REVISION_KEY];
  await store.clearAll();

  assert.ok(first);
  assert.notEqual(world.local.data[SETTINGS_REVISION_KEY], first);
});

test("清除全部数据中途失败：清除之前打开的表单写不回去，没有修订号的也一样", async () => {
  const failing: readonly [string, (world: Areas) => ExtensionStorage][] = [
    ["删本机存储失败", (world) => ({ ...world, local: removeFails(world.local) })],
    ["删会话存储失败", (world) => ({ ...world, session: removeFails(world.session) })],
  ];
  for (const [step, broken] of failing) {
    const world = areas();
    const store = storeOn(world);
    const opened = await store.load();
    const form = { ...opened, ...DEEPSEEK, aiApiKey: "sk-ds", ...DATA_CONSENT_CONFIRMED };
    await store.save(form, opened.settingsRevision);
    const beforeClear = revisionOf(world);

    await assert.rejects(storeOn(broken(world)).clearAll(), /IO error/, step);

    for (const revision of [opened.settingsRevision, beforeClear]) {
      await assert.rejects(store.save(form, revision), { code: "SETTINGS_STALE" }, step);
    }
  }
});

test("清除全部数据时存储写满：修订号写不进去也不挡住清除，删完再写", async () => {
  const world = areas({ [SETTINGS_STORAGE_KEY]: DEEPSEEK, [SETTINGS_REVISION_KEY]: "revision-old" });
  const full: ExtensionStorage = {
    ...world,
    local: {
      ...world.local,
      async set(entries) {
        if (SETTINGS_STORAGE_KEY in world.local.data) throw new Error("Resource::kQuotaBytes quota exceeded");
        await world.local.set(entries);
      },
    },
  };

  await storeOn(full).clearAll();

  assert.deepEqual(Object.keys(world.local.data), clearTargets("all").renew);
  assert.notEqual(world.local.data[SETTINGS_REVISION_KEY], "revision-old");
});

test("清除全部数据时修订号一直写不进去：照样删掉，报原来的错，旧修订号也不留着", async () => {
  const form = { ...DEEPSEEK, aiApiKey: "sk-ds" };
  const world = areas();
  const store = storeOn(world);
  await store.save(form, NO_REVISION);
  const beforeClear = revisionOf(world);

  await assert.rejects(storeOn(writesFail(world)).clearAll(), /quota exceeded/);

  assert.deepEqual(world.local.data, {});
  assert.deepEqual(world.session.data, {});
  await assert.rejects(store.save(form, beforeClear), { code: "SETTINGS_STALE" });
});

test("数据同意单独写入：勾上记下当前的版本和指纹，取消就清掉，密钥和其余设置不动", async () => {
  const world = restrictable();
  const store = storeOn(world);
  await store.save(
    { presetId: "deepseek", aiModel: "deepseek-v4-flash", aiApiKey: "sk-ds", accentTheme: "ochre" },
    NO_REVISION,
  );

  const given = await store.setDataConsent(true);
  assert.equal(given.dataConsentVersion, DATA_CONSENT_CONFIRMED.dataConsentVersion);
  assert.equal(given.dataConsentFingerprint, DATA_CONSENT_CONFIRMED.dataConsentFingerprint);
  assert.equal(validate(given).ok, true);

  const withdrawn = await store.setDataConsent(false);
  assert.equal(withdrawn.dataConsentVersion, 0);
  assert.equal(withdrawn.dataConsentFingerprint, "");
  assert.equal(withdrawn.aiApiKey, "sk-ds");
  assert.equal(withdrawn.accentTheme, "ochre");
  assert.equal(savedSettings(world)["dataConsentVersion"], 0);
});

test("数据同意只认 true：跨消息传来的别的值不算同意，已有的同意也收回", async () => {
  for (const given of ["false", "yes", 1, {}]) {
    const world = areas();
    const store = storeOn(world);
    await store.setDataConsent(true);

    // @ts-expect-error 类型挡不住跨消息传来的值
    const saved = await store.setDataConsent(given);

    assert.equal(saved.dataConsentVersion, 0, JSON.stringify(given));
    assert.equal(saved.dataConsentFingerprint, "", JSON.stringify(given));
    assert.equal(savedSettings(world)["dataConsentVersion"], 0, JSON.stringify(given));
  }
});

// ============================================================
// 写入排队
// ============================================================

test("两个设置页同时保存：先保存的写 storage.local 失败、回滚密钥，不冲掉后保存成功的新密钥", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-old" }, NO_REVISION);
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
          throw new Error("Resource::kQuotaBytes quota exceeded");
        }
        return world.local.set(entries);
      },
    },
  };

  // 第一个页面换成 Moonshot，写本机存储卡住、随后失败。
  const revision = revisionOf(world);
  const moonshot = { presetId: "moonshot", aiApiKey: "sk-moon", ...DATA_CONSENT_CONFIRMED };
  const first = storeOn(storage).save(moonshot, revision);
  // 卡住的时候第二个页面换成 Anthropic 并保存。
  const second = storeOn(storage).save(ANTHROPIC_NEW, revision);
  await Promise.race([firstWriting.promise, second.catch(() => {})]);
  failFirst.resolve();
  await assert.rejects(first, /quota exceeded/);
  await second;

  const loaded = await storeOn(world).load();
  assert.equal(loaded.presetId, "anthropic");
  assert.equal(loaded.aiApiKey, "sk-ant-new", "后保存成功的密钥还在，没被回滚换成旧的");
});

test("两个页面同时改不同的即改即存设置：两项都留下，不互相盖回旧值", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
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

  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  await store.update({ accentTheme: "ochre" });
  await store.setDataConsent(true);
  await store.confirmActivation();
  await store.clearAll();

  assert.deepEqual(requests, Array(5).fill({ name: SETTINGS_LOCK_NAME, mode: "exclusive" }));
});

test("读到本机残留时换独占锁重读：读的时候开了记住，不会把刚写的记录删掉", async () => {
  const world = restrictable({
    [SETTINGS_STORAGE_KEY]: { ...DEEPSEEK, rememberApiKey: false },
    [API_KEY_LOCAL_KEY]: { version: 1, key: "sk-leftover", origin: DEEPSEEK_ORIGIN },
  });
  const held = holdLocalRead(world.local, 1);
  const { locks, requests } = recordingLocks();
  const reading = storeOn({ ...world, local: held.local }, locks).load();
  await held.reading;

  // 第一次读停在锁里，保存排在它后面。
  const form = { ...DEEPSEEK, aiApiKey: "sk-ds", rememberApiKey: true };
  const saving = storeOn(world, locks).save(form, revisionOf(world));
  await nextTurn();
  held.release();
  await saving;
  const loaded = await reading;

  assert.equal(loaded.aiApiKey, "sk-ds");
  assert.deepEqual(world.local.data[API_KEY_LOCAL_KEY], REMEMBERED_RECORD);
  assert.deepEqual(
    requests.map(({ mode }) => mode),
    ["shared", "exclusive", "exclusive"],
  );
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
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
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

  const saving = storeOn(storage).save(ANTHROPIC_NEW, revisionOf(world));
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

  const saving = store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
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

  assert.deepEqual(Object.keys(world.local.data), clearTargets("all").renew, "本机只留下要换新的键");
  assert.notEqual(world.local.data[SETTINGS_REVISION_KEY], "旧值");
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
  await store.save(
    { presetId: "deepseek", aiModel: "deepseek-v4-flash", aiApiKey: "sk-ds", accentTheme: "ochre" },
    NO_REVISION,
  );

  assert.deepEqual(await store.confirmActivation(), { state: "current" }, "只回启用状态，不带设置和密钥");
  const confirmed = await store.load();

  assert.equal(confirmed.dataConsentVersion, 0);
  assert.equal(confirmed.aiApiKey, "sk-ds");
  assert.equal(confirmed.accentTheme, "ochre");
  assert.deepEqual(world.session.data[API_KEY_SESSION_KEY], { key: "sk-ds", origin: DEEPSEEK_ORIGIN });
  assertNoKeyFields(savedSettings(world));
});

test("同意了数据说明不算启用", async () => {
  const world = areas();
  await storeOn(world).save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
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

  await assert.rejects(store.save(staleForm, staleForm.settingsRevision), { code: "SETTINGS_STALE" });
  assert.equal((await store.activation()).state, "needed");

  // 修订号对得上时启用确认也带不进去，只有 confirmActivation 写它。
  await store.save(staleForm, revisionOf(world));
  assert.equal((await store.activation()).state, "needed");

  // @ts-expect-error 启用确认只走 confirmActivation
  await store.update({ activationVersion: ACTIVATION_VERSION, activationFingerprint: ACTIVATION_FINGERPRINT });
  assert.equal((await store.activation()).state, "needed");
});

test("保存不带启用字段的表单不会抹掉确认", async () => {
  const world = areas();
  const store = storeOn(world);
  await store.confirmActivation();

  await store.save({ ...DEEPSEEK, aiApiKey: "sk-ds" }, NO_REVISION);
  await store.update({ accentTheme: "ochre" });

  assert.deepEqual(await store.activation(), { state: "current" });
});
