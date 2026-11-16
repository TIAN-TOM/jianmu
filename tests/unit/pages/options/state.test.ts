// 设置页的状态：等授权的工夫别的页面清了密钥，点击时的表单作废，不把清掉的密钥写回去；
// 本页刚勾的同意还没落地就点保存，保存等它写完，同意不被盖回去。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOptionsState } from "../../../../src/pages/options/state.ts";
import type { LoadedSettings, WrittenSettings } from "../../../../src/platform/settings-store.ts";
import { SETTINGS_REVISION_KEY } from "../../../../src/shared/names.ts";
import { DATA_CONSENT_CONFIRMED, DEFAULTS, normalize, type SettingsInput } from "../../../../src/shared/settings-schema.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { until } from "../../../helpers/wait-until.ts";

type Listener = (changes: object, area: string) => void;

function world(initial: Record<string, unknown>) {
  let current: LoadedSettings = { ...normalize({ ...DEFAULTS, ...initial }), settingsRevision: "r1" };
  const saves: SettingsInput[] = [];
  const updates: SettingsInput[] = [];
  let consentFails = false;
  const listeners = new Set<Listener>();
  const permission = deferred();
  const written = (next: LoadedSettings, previousRevision: string): WrittenSettings => ({ ...next, previousRevision });
  const store = {
    load: async () => current,
    async save(form: SettingsInput, expected: string) {
      if (expected !== current.settingsRevision) throw Object.assign(new Error("stale"), { code: "SETTINGS_STALE" });
      saves.push(form);
      const before = current.settingsRevision;
      current = { ...normalize(form), settingsRevision: `${before}+save` };
      return written(current, before);
    },
    async update(patch: SettingsInput) {
      const before = current.settingsRevision;
      updates.push(patch);
      current = { ...normalize({ ...current, ...patch }), settingsRevision: before };
      return written(current, before);
    },
    async setDataConsent(given: boolean) {
      const before = current.settingsRevision;
      await nextTurn();
      if (consentFails) throw new Error("存储写满了");
      current = { ...current, ...(given ? DATA_CONSENT_CONFIRMED : { dataConsentVersion: 0, dataConsentFingerprint: "" }), settingsRevision: `${before}+consent` };
      return written(current, before);
    },
  };
  const state = createOptionsState({
    store,
    api: { send: async () => ({ ok: true, value: { released: [], failed: [] } }) as never },
    requestHost: async () => {
      await permission.promise;
      return true;
    },
    download: () => {},
    storageChanged: { addListener: (listener) => void listeners.add(listener), removeListener: (listener) => void listeners.delete(listener) },
  });
  /** 别的页面改了设置：存储换成 next，发一条修订号变化。 */
  const external = (next: Record<string, unknown>) => {
    current = { ...normalize({ ...current, ...next }), settingsRevision: `${current.settingsRevision}+other` };
    for (const listener of listeners) listener({ [SETTINGS_REVISION_KEY]: { newValue: current.settingsRevision } }, "local");
  };
  return { state, saves, updates, permission, external, current: () => current, failConsent: () => void (consentFails = true) };
}

const GATEWAY = { presetId: "custom", protocol: "openai", aiBaseUrl: "https://gateway.example.com/v1", aiModel: "m" };

test("等授权的工夫别的页面清了密钥：这次保存作废，清掉的密钥不写回去", async () => {
  const w = world({ ...GATEWAY, aiApiKey: "sk-old", aiApiKeyOrigin: "https://gateway.example.com/" });
  await w.state.load();
  const saving = w.state.save();
  w.external({ aiApiKey: "", aiApiKeyOrigin: "" });
  await until(() => w.state.form.value?.aiApiKey === "");
  w.permission.resolve();
  assert.equal(await saving, false);
  assert.deepEqual(w.saves, []);
  assert.equal(w.current().aiApiKey, "");
  assert.match(w.state.aiStatus.value?.text ?? "", /别的页面改过/);
});

test("刚勾的同意还没落地就点保存：保存排在它后面，同意留着", async () => {
  const w = world({ ...GATEWAY });
  await w.state.load();
  const consent = w.state.setConsent(true);
  const saving = w.state.save();
  w.permission.resolve();
  await consent;
  assert.equal(await saving, true);
  assert.equal(w.saves.length, 1);
  assert.equal(w.current().dataConsentVersion, DATA_CONSENT_CONFIRMED.dataConsentVersion);
});

test("打开就出结论：没同意时先同意当前的数据说明，同意存上了才打开开关；同意没存上就不打开", async () => {
  const w = world({ ...GATEWAY });
  await w.state.load();
  await w.state.enableAuto();
  assert.equal(w.current().dataConsentVersion, DATA_CONSENT_CONFIRMED.dataConsentVersion);
  assert.deepEqual(w.updates, [{ autoOverview: true }]);
  assert.equal(w.current().autoOverview, true);
  assert.equal(w.state.saved.value?.autoOverview, true);

  const broken = world({ ...GATEWAY });
  await broken.state.load();
  broken.failConsent();
  await broken.state.enableAuto();
  assert.deepEqual(broken.updates, [], "同意没存上，开关不动");
  assert.equal(broken.current().autoOverview, false);
  assert.match(broken.state.autoStatus.value?.text ?? "", /没有打开/);
});
