// 设置页的状态：等授权的工夫别的页面清了密钥，点击时的表单作废，不把清掉的密钥写回去；
// 本页刚勾的同意还没落地就点保存，保存等它写完，同意不被盖回去；推理强度和概览分块改了马上存，不等保存、不申请权限，
// 保存也不把它们盖回去；实际档位按存着的档位问，只认最后一问。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOptionsState } from "../../../../src/pages/options/state.ts";
import type { LoadedSettings, WrittenSettings } from "../../../../src/platform/settings-store.ts";
import { SETTINGS_REVISION_KEY, SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { DATA_CONSENT_CONFIRMED, DEFAULTS, normalize, type SettingsInput } from "../../../../src/shared/settings-schema.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { until } from "../../../helpers/wait-until.ts";

type Listener = (changes: object, area: string) => void;

function world(initial: Record<string, unknown>) {
  let current: LoadedSettings = { ...normalize({ ...DEFAULTS, ...initial }), settingsRevision: "r1" };
  const saves: SettingsInput[] = [];
  const updates: SettingsInput[] = [];
  let consentFails = false;
  let updateFails = false;
  let hostAsks = 0;
  const listeners = new Set<Listener>();
  const permission = deferred();
  const previews: { efforts: Record<string, string> }[] = [];
  // 推理强度预览：默认按选的照回；hold 以后每一问都挂起，按需要的顺序放行。
  let hold = false;
  const held: { req: { efforts: Record<string, string> }; release: (items: unknown[]) => void }[] = [];
  const echo = (req: { efforts: Record<string, string> }) =>
    Object.entries(req.efforts).map(([feature, effort]) => ({ feature, model: "m", requested: effort, effective: effort }));
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
      if (updateFails) throw new Error("存储写满了");
      updates.push(patch);
      // 和真的设置仓库一样：推理强度只改带来的那几项功能。
      const efforts = Object.hasOwn(patch, "featureEfforts") ? { featureEfforts: { ...current.featureEfforts, ...(patch.featureEfforts as object) } } : {};
      current = { ...normalize({ ...current, ...patch, ...efforts }), settingsRevision: before };
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
    api: {
      send: (async (type: string, req: { efforts: Record<string, string> }) => {
        if (type !== "ai.effortPreview") return { ok: true, value: { released: [], failed: [] } };
        previews.push(req);
        if (!hold) return { ok: true, value: { items: echo(req) } };
        const items = await new Promise<unknown[]>((release) => held.push({ req, release }));
        return { ok: true, value: { items } };
      }) as never,
      connect: () => assert.fail("这些测试不导出、不导入备份"),
    },
    requestHost: async () => {
      hostAsks += 1;
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
  /** 别处改了即改即存的一项（比如工具栏图标的右键菜单）：存储换成 next，修订号不变，只有设置本身的变化事件。 */
  const externalInstant = (next: Record<string, unknown>) => {
    current = { ...normalize({ ...current, ...next }), settingsRevision: current.settingsRevision };
    for (const listener of listeners) listener({ [SETTINGS_STORAGE_KEY]: { newValue: {} } }, "local");
  };
  return {
    state,
    saves,
    updates,
    permission,
    external,
    externalInstant,
    previews,
    held,
    echo,
    holdPreviews: () => void (hold = true),
    current: () => current,
    failConsent: () => void (consentFails = true),
    failUpdates: () => void (updateFails = true),
    hostAsks: () => hostAsks,
  };
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

test("别处改了即改即存的开关（修订号不变）：页面上的开关跟着变，表单上没保存的不动，也不提示别的页面改过", async () => {
  const w = world({ ...GATEWAY, aiApiKey: "sk-old", aiApiKeyOrigin: "https://gateway.example.com/", inPageCard: true });
  await w.state.load();
  w.state.edit({ aiModel: "还没保存的模型" });

  w.externalInstant({ inPageCard: false, autoOverview: true });
  await until(() => w.state.saved.value?.autoOverview === true);
  assert.equal(w.state.saved.value?.inPageCard, false);
  assert.equal(w.state.form.value?.aiModel, "还没保存的模型");
  assert.equal(w.state.aiStatus.value, null);

  // 本页接着改一项：存得上，别处改的那两项不被盖回去。
  await w.state.saveInstant({ uiFontScale: 125 });
  assert.equal(w.current().autoOverview, true);
  assert.equal(w.current().inPageCard, false);
  assert.equal(w.state.saved.value?.uiFontScale, 125);
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

test("推理强度和概览分块：载入时按存着的档位问实际档位；改一档马上存下，不申请权限，存好再问实际档位", async () => {
  const w = world({ ...GATEWAY, featureEfforts: { qa: "high" } });
  await w.state.load();
  await until(() => w.state.efforts.value !== null);
  assert.equal(w.previews[0]?.efforts["qa"], "high");
  assert.equal(w.previews[0]?.efforts["analysis"], "off", "没选的功能是关");

  await w.state.saveInstant({ featureEfforts: { analysis: "medium" } });
  assert.equal(w.current().featureEfforts.analysis, "medium");
  assert.equal(w.current().featureEfforts.qa, "high", "别的功能照旧");
  assert.equal(w.state.saved.value?.featureEfforts.analysis, "medium");
  assert.ok(await until(() => w.state.efforts.value?.find((item) => item.feature === "analysis")?.requested === "medium"), "存好以后重新问实际档位");
  assert.equal(w.previews.at(-1)?.efforts["qa"], "high", "问的是存着的整份档位");

  await w.state.saveInstant({ analysisChunkMode: "short" });
  assert.equal(w.current().analysisChunkMode, "short");
  assert.equal(w.state.saved.value?.analysisChunkMode, "short");

  assert.deepEqual(w.saves, [], "不走保存并授权");
  assert.equal(w.hostAsks(), 0);
});

test("模型改了还没保存时改档位，等授权的工夫又改一档和分块：保存不把它们盖回去", async () => {
  const w = world({ ...GATEWAY });
  await w.state.load();
  w.state.edit({ aiModel: "m2" });
  await w.state.saveInstant({ featureEfforts: { analysis: "high" } });
  assert.equal(w.current().aiModel, "m", "表单上没保存的模型不跟着存");
  assert.equal(w.state.form.value?.aiModel, "m2", "表单上填的也不丢");

  const saving = w.state.save();
  await w.state.saveInstant({ featureEfforts: { qa: "low" }, analysisChunkMode: "whole" });
  w.permission.resolve();
  assert.equal(await saving, true);
  assert.equal(w.current().aiModel, "m2");
  assert.equal(w.current().featureEfforts.analysis, "high");
  assert.equal(w.current().featureEfforts.qa, "low");
  assert.equal(w.current().analysisChunkMode, "whole");
});

test("推理强度：连着改两项，两项都存下；先问的回复晚到也不盖掉后问的", async () => {
  const w = world({ ...GATEWAY });
  await w.state.load();
  await until(() => w.state.efforts.value !== null);
  w.holdPreviews();
  void w.state.saveInstant({ featureEfforts: { qa: "low" } });
  void w.state.saveInstant({ featureEfforts: { analysis: "high" } });
  await until(() => w.held.length === 2);
  assert.equal(w.current().featureEfforts.qa, "low");
  assert.equal(w.current().featureEfforts.analysis, "high");
  const [first, second] = w.held;
  second?.release(w.echo(second.req));
  await until(() => w.state.efforts.value?.find((item) => item.feature === "analysis")?.requested === "high");
  first?.release(w.echo(first.req));
  await nextTurn();
  await nextTurn();
  assert.equal(w.state.efforts.value?.find((item) => item.feature === "analysis")?.requested, "high");
});

test("推理强度没存上：提示没有保存，页面记着的还是原来的档位", async () => {
  const w = world({ ...GATEWAY });
  await w.state.load();
  w.failUpdates();
  await w.state.saveInstant({ featureEfforts: { qa: "high" } });
  assert.match(w.state.aiStatus.value?.text ?? "", /没有保存/);
  assert.equal(w.state.saved.value?.featureEfforts.qa, "off");
  assert.equal(w.current().featureEfforts.qa, "off");
});

test("恢复备份：读文件的工夫就占着，这期间点导出、清除、另一次恢复都不发；读不出、读不懂、导完都放开", async () => {
  const sent: string[] = [];
  const connected: string[] = [];
  const state = createOptionsState({
    store: { load: async () => assert.fail(), save: async () => assert.fail(), update: async () => assert.fail(), setDataConsent: async () => assert.fail() },
    api: {
      send: (async (type: string) => (sent.push(type), { ok: true, value: {} })) as never,
      connect: ((name: string) => (connected.push(name), assert.fail("读文件时不该连后台"))) as never,
    },
    requestHost: async () => true,
    download: () => assert.fail("读文件时不该导出"),
  });
  let finishReading!: (text: string) => void;
  const reading = new Promise<string>((resolve) => (finishReading = resolve));
  const importing = state.importBackup(() => reading);
  assert.equal(state.busy.value, "import", "读文件之前就占住");
  await state.exportBackup();
  await state.clearData("all");
  let readAgain = false;
  await state.importBackup(async () => ((readAgain = true), "{}"));
  assert.deepEqual([sent, connected, readAgain], [[], [], false], "读文件期间别的操作都不发");
  finishReading("不是 JSON");
  await importing;
  assert.equal(state.busy.value, null, "读不懂也放开");
  assert.match(state.dataStatus.value?.text ?? "", /读不懂这个文件/);

  await state.importBackup(async () => Promise.reject(new Error("文件被移走了")));
  assert.equal(state.busy.value, null, "读不出也放开");
  assert.match(state.dataStatus.value?.text ?? "", /读不出这个文件/);

  await state.importBackup(async () => JSON.stringify({ hello: 1 }));
  assert.equal(state.busy.value, null, "认不出格式也放开");
  assert.match(state.dataStatus.value?.text ?? "", /^恢复失败/);
});
