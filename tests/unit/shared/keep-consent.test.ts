// 开发者本人的日用包里沿用确认和同意：确认过、同意过的人说明的条目变了也照旧算数，不拦读取、不停发送，多出来的条目交给侧边栏列出；
// 从没确认、没同意过的照旧要走一遍；侧边栏点过「知道了」以后两份说明都记成当前这一版。对外的发行包一点不变：条目变了仍然要重新确认、重新同意。
// 产品模块加载时就读构建开关，两种取值各起一个子进程跑同一段脚本。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { carryConsent, carryNotices } from "../../../src/core/consent-carry.ts";
import { everAgreed, versionStamps, type CarriedItems, type NoticeItem, type NoticeTable } from "../../../src/core/consent.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// 首发前开发期间存下的确认和同意。LEGACY 是开发者本人现在存着的：启用说明第 3 版、数据说明第 5 版，条目和首发的第 1 版一样，只是版本号不同。
// STALE 是更早的：同样的版本号，加上截图那几条之前的旧指纹。
const LEGACY = { activationVersion: 3, activationFingerprint: "372b4707b69fb4f1", dataConsentVersion: 5, dataConsentFingerprint: "7c550f58c5fddf7f" };
const STALE = { activationVersion: 3, activationFingerprint: "c7c74de73be1ef90", dataConsentVersion: 5, dataConsentFingerprint: "b459474109f65107" };
const NEVER = { activationVersion: 0, activationFingerprint: "", dataConsentVersion: 0, dataConsentFingerprint: "" };

const SCRIPT = `
const schema = await import("./src/shared/settings-schema.ts");
const { dataConsentStatus } = await import("./src/shared/consent-status.ts");
const consent = await import("./src/core/consent.ts");
const { createSettingsStore } = await import("./src/platform/settings-store.ts");
const STALE = ${JSON.stringify(STALE)};
const LEGACY = ${JSON.stringify(LEGACY)};
const NEVER = ${JSON.stringify(NEVER)};
const AUTO = { kind: "trigger", id: "auto-on-open-tabs" };
const rules = { dataConsentVersion: consent.DATA_CONSENT_VERSION, dataConsentFingerprint: consent.DATA_CONSENT_FINGERPRINT };
const ids = (status) => status.state === "current" ? { state: "current", carried: [...(status.carried?.activation ?? []), ...(status.carried?.consent ?? [])].map(({ id }) => id) } : { state: status.state, updated: status.updated };
const area = (data) => ({
  async get(keys) { return Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((key) => key in data).map((key) => [key, structuredClone(data[key])])); },
  async set(entries) { Object.assign(data, structuredClone(entries)); },
  async remove(keys) { for (const key of typeof keys === "string" ? [keys] : keys) delete data[key]; },
});
const local = { jianmu_settings: { ...STALE } };
const store = createSettingsStore({ storage: { local: area(local), session: area({}) }, locks: { exclusive: (_name, work) => Promise.resolve().then(work), shared: (_name, work) => Promise.resolve().then(work) } });
const before = ids(await store.activation());
await store.confirmActivation();
const saved = local.jianmu_settings;

// 开发者本人现在存着的记录：经设置仓库读出来的启用状态，和清除全部数据以后的。
const legacyLocal = { jianmu_settings: { ...LEGACY } };
const legacyStore = createSettingsStore({ storage: { local: area(legacyLocal), session: area({}) }, locks: { exclusive: (_name, work) => Promise.resolve().then(work), shared: (_name, work) => Promise.resolve().then(work) } });
const legacyStored = ids(await legacyStore.activation());
await legacyStore.clearAll();
const legacyCleared = { activation: ids(await legacyStore.activation()), consent: ids(dataConsentStatus(schema.normalize(legacyLocal.jianmu_settings ?? {}))) };

// 写入一侧：启用说明确认过、数据说明从没同意过（或者同意后又取消了），点确认不能替他同意。
const consentAfter = async (settings, untick) => {
  const data = { jianmu_settings: { ...settings } };
  const other = createSettingsStore({ storage: { local: area(data), session: area({}) }, locks: { exclusive: (_name, work) => Promise.resolve().then(work), shared: (_name, work) => Promise.resolve().then(work) } });
  if (untick) await other.setDataConsent(false);
  await other.confirmActivation();
  return [data.jianmu_settings.dataConsentVersion, consent.dataConsentGiven(data.jianmu_settings, rules)];
};

// 确认的路由：启用本来就算数（沿用着）时只记下看过，不广播、不补注入；从没确认过的照常广播、补注入。
const { activationRoutes } = await import("./src/background/routes/activation.ts");
const routeCalls = async (settings) => {
  const data = { jianmu_settings: { ...settings } };
  const routeStore = createSettingsStore({ storage: { local: area(data), session: area({}) }, locks: { exclusive: (_name, work) => Promise.resolve().then(work), shared: (_name, work) => Promise.resolve().then(work) } });
  const calls = [];
  const routes = activationRoutes({
    settings: routeStore,
    messenger: { toPages: async () => void calls.push("toPages"), toTabs: async () => void calls.push("toTabs") },
    contentTargets: async () => [1],
    reinject: async () => (calls.push("reinject"), { injected: [], failed: [7] }),
  });
  const reply = await routes["activation.confirm"].handler({}, {});
  return { calls, state: reply.value.state, unreachable: reply.value.unreachableTabs };
};
console.log(JSON.stringify({
  legacy: ids(schema.activationStatus(LEGACY)),
  consentLegacy: ids(dataConsentStatus(LEGACY)),
  givenLegacy: consent.dataConsentGiven(LEGACY, rules),
  autoLegacy: consent.consentCovers(consent.DATA_CONSENT_TABLE, { version: LEGACY.dataConsentVersion, fingerprint: LEGACY.dataConsentFingerprint }, AUTO),
  validLegacy: schema.validate({ ...LEGACY, presetId: "custom", aiBaseUrl: "https://api.example.com/v1", aiApiKey: "k", aiModel: "m" }).errors.includes(consent.DATA_CONSENT_ERROR),
  legacyStored,
  legacyCleared,
  routeLegacy: await routeCalls(LEGACY),
  stale: ids(schema.activationStatus(STALE)),
  staleGroups: Object.fromEntries(Object.entries(schema.activationStatus(STALE).carried ?? {}).map(([key, items]) => [key, items.map(({ id }) => id)])),
  never: ids(schema.activationStatus(NEVER)),
  consentStale: ids(dataConsentStatus(STALE)),
  consentNever: ids(dataConsentStatus(NEVER)),
  givenStale: consent.dataConsentGiven(STALE, rules),
  givenNever: consent.dataConsentGiven(NEVER, rules),
  autoStale: consent.consentCovers(consent.DATA_CONSENT_TABLE, { version: STALE.dataConsentVersion, fingerprint: STALE.dataConsentFingerprint }, AUTO),
  validStale: schema.validate({ ...STALE, presetId: "custom", aiBaseUrl: "https://api.example.com/v1", aiApiKey: "k", aiModel: "m" }).errors.includes(consent.DATA_CONSENT_ERROR),
  storeBefore: before,
  acknowledged: { activation: saved.activationFingerprint === consent.ACTIVATION_FINGERPRINT, consent: saved.dataConsentFingerprint === consent.DATA_CONSENT_FINGERPRINT },
  after: ids(schema.activationStatus(saved)),
  neverConsented: await consentAfter({ ...STALE, dataConsentVersion: 0, dataConsentFingerprint: "" }, false),
  untickedConsent: await consentAfter(STALE, true),
  routeStale: await routeCalls(STALE),
  routeNever: await routeCalls(NEVER),
}));
`;

function run(flags: string): Record<string, unknown> {
  const output = execFileSync(process.execPath, ["--import", flags, "--input-type=module", "-e", SCRIPT], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

test("日用包：首发前存下的确认和同意照旧沿用，只把多出的评论区那一条交给侧边栏、不打断；清除全部数据以后照旧要走一遍", () => {
  const daily = run("./tests/helpers/daily-build-flags.ts");
  // 第 1 版的条目和存着的一样，日用包多出只有评论区那一条的第 2 版：两份说明各列这一条。
  assert.deepEqual(daily.legacy, { state: "current", carried: ["top-comments", "top-comments"] }, "启用照旧算数，侧边栏顶上只列评论区那一条");
  assert.deepEqual(daily.consentLegacy, { state: "current", carried: ["top-comments"] });
  assert.equal(daily.givenLegacy, true, "模型请求照常发");
  assert.equal(daily.autoLegacy, true, "打开就出结论照常跑");
  assert.equal(daily.validLegacy, false, "设置校验不报没同意");
  assert.deepEqual(daily.legacyStored, daily.legacy, "经设置仓库读出来一样");
  assert.deepEqual(daily.routeLegacy, { calls: [], state: "current", unreachable: [] }, "本来就算启用：不广播、不补注入");
  assert.deepEqual(daily.legacyCleared, { activation: { state: "needed", updated: false }, consent: { state: "needed", updated: false } });
});

test("发行包：首发前存下的确认和同意不算数，按第一次处理：要重新启用、重新同意，不提示说明有更新", () => {
  const release = run("./scripts/lib/release-globals.mjs");
  assert.deepEqual(release.legacy, { state: "needed", updated: false });
  assert.deepEqual(release.consentLegacy, { state: "needed", updated: false });
  assert.equal(release.givenLegacy, false, "不发给模型");
  assert.equal(release.autoLegacy, false, "打开就出结论停着");
  assert.equal(release.validLegacy, true, "设置校验报没同意");
  assert.deepEqual(release.legacyStored, release.legacy);
  assert.deepEqual(release.routeLegacy, { calls: ["toPages", "toTabs", "reinject"], state: "current", unreachable: [7] }, "确认以后照第一次启用广播、补注入");
  assert.deepEqual(release.legacyCleared, { activation: { state: "needed", updated: false }, consent: { state: "needed", updated: false } });
});

test("日用包：确认过、同意过的照旧算数，多出来的条目交给侧边栏；从没确认、没同意的照旧要走一遍；看过以后两份都记成当前这一版", () => {
  const daily = run("./tests/helpers/daily-build-flags.ts");
  // 指纹认不出确认的是哪一版、版本号又比表里的都大：条目全列出来，宁可多列。
  const activationAll = ["video-info", "transcript", "official-summary", "watch-state", "window-tabs", "watch-later", "display", "pick-mode", "material", "cache", "triage", "saved", "bili-login-state", "watch-later-progress", "open-tabs", "current-frame", "top-comments"];
  const consentAll = ["transcript", "selection", "question", "video-title", "uploader-and-description", "official-summary", "api-key", "ai-features", "chosen-provider", "on-click", "imported-transcript", "video-duration", "auto-on-open-tabs", "tidy-transcript", "keep-running", "current-frame", "frame-explain", "top-comments"];
  assert.deepEqual(daily.stale, { state: "current", carried: [...activationAll, ...consentAll] });
  assert.deepEqual(daily.staleGroups, { activation: activationAll, consent: consentAll }, "在本机读的和发给模型的分开放");
  assert.deepEqual(daily.never, { state: "needed", updated: false });
  assert.deepEqual(daily.consentStale, { state: "current", carried: consentAll });
  assert.deepEqual(daily.consentNever, { state: "needed", updated: false });
  assert.equal(daily.givenStale, true);
  assert.equal(daily.givenNever, false);
  assert.equal(daily.autoStale, true, "打开就出结论照常跑");
  assert.equal(daily.validStale, false, "设置校验不再报没同意");
  assert.deepEqual(daily.storeBefore, daily.stale);
  assert.deepEqual(daily.acknowledged, { activation: true, consent: true });
  assert.deepEqual(daily.after, { state: "current", carried: [] });
  assert.deepEqual(daily.neverConsented, [0, false], "数据说明从没同意过：点确认不替他同意");
  assert.deepEqual(daily.untickedConsent, [0, false], "同意后又取消了：点确认不替他同意");
  assert.deepEqual(daily.routeStale, { calls: [], state: "current", unreachable: [] }, "只是记下看过：不广播、不补注入");
  assert.deepEqual(daily.routeNever, { calls: ["toPages", "toTabs", "reinject"], state: "current", unreachable: [7] });
});

test("发行包：条目变了仍然要重新确认、重新同意，没同意的内容不发，打开就出结论停着；点确认只记启用说明", () => {
  const release = run("./scripts/lib/release-globals.mjs");
  assert.deepEqual(release.stale, { state: "needed", updated: false }, "认不出确认的是哪一版，按第一次处理");
  assert.deepEqual(release.never, { state: "needed", updated: false });
  assert.deepEqual(release.consentStale, { state: "needed", updated: false });
  assert.equal(release.givenStale, false);
  assert.equal(release.givenNever, false);
  assert.equal(release.autoStale, false);
  assert.equal(release.validStale, true);
  assert.deepEqual(release.acknowledged, { activation: true, consent: false }, "启用确认不顺带改数据同意");
  assert.deepEqual(release.after, { state: "current", carried: [] });
  assert.deepEqual(release.neverConsented, [0, false]);
  assert.deepEqual(release.untickedConsent, [0, false]);
  assert.deepEqual(release.routeStale, { calls: ["toPages", "toTabs", "reinject"], state: "current", unreachable: [7] }, "发行包照常广播、补注入");
});

const item = <Kind extends string>(kind: Kind, id: string): NoticeItem<Kind> => ({ kind, id, text: id, en: id });

const TABLE: NoticeTable<"read"> = [
  { version: 1, items: [item("read", "a")] },
  { version: 2, items: [item("read", "b")] },
  { version: 3, items: [item("read", "c")] },
];
const CONSENT: NoticeTable<"category"> = [
  { version: 1, items: [item("category", "x")] },
  { version: 2, items: [item("category", "y")] },
];
const [V1, V2, V3] = versionStamps(TABLE);
const [C1, C2] = versionStamps(CONSENT);
const ids = (status: { readonly state: string; readonly carried?: CarriedItems }) =>
  status.state === "current" ? [...(status.carried?.activation ?? []), ...(status.carried?.consent ?? [])].map(({ id }) => id) : status.state;

test("沿用的规则：存着正整数版本才算确认过；从没确认过的照旧要走一遍；多出来的条目认得出就只列之后的，认不出从那一版起列", () => {
  assert.equal(everAgreed({ version: 3 }), true);
  for (const version of [0, -1, "3", null, undefined, 1.5]) assert.equal(everAgreed({ version }), false, String(version));
  const none = { table: CONSENT, stored: {} };
  assert.deepEqual(carryNotices(TABLE, {}, none), { state: "needed", updated: false, items: [item("read", "a"), item("read", "b"), item("read", "c")] });
  assert.deepEqual(carryNotices(TABLE, V3 ?? {}, none), { state: "current" });
  assert.deepEqual(ids(carryNotices(TABLE, V1 ?? {}, none)), ["b", "c"], "认得出确认的是第 1 版");
  assert.deepEqual(ids(carryNotices(TABLE, { version: 2, fingerprint: "0000000000000000" }, none)), ["b", "c"], "第 2 版后来又并进了条目");
  assert.deepEqual(ids(carryNotices(TABLE, { version: 7, fingerprint: V1?.fingerprint }, none)), ["b", "c"], "版本号表里没有、指纹认得出是第 1 版");
  assert.deepEqual(carryNotices(TABLE, { version: 7, fingerprint: V3?.fingerprint }, none), { state: "current" }, "版本号表里没有、条目和当前一样：什么都不列");
  assert.deepEqual(ids(carryNotices(TABLE, { version: 7, fingerprint: "0000000000000000" }, none)), ["a", "b", "c"], "版本号和指纹都认不出：全列");
  assert.deepEqual(ids(carryNotices(TABLE, V2 ?? {}, { table: CONSENT, stored: C1 ?? {} })), ["c", "y"], "两份说明多出来的合在一起");
  assert.deepEqual(ids(carryNotices(TABLE, V3 ?? {}, { table: CONSENT, stored: C1 ?? {} })), ["y"], "启用说明没变、数据说明变了");
  assert.deepEqual(carryNotices(TABLE, V3 ?? {}, { table: CONSENT, stored: { version: 0 } }), { state: "current" }, "数据说明从没同意过：等用户自己去设置页同意");
  assert.deepEqual(ids(carryConsent(CONSENT, C1 ?? {})), ["y"]);
  assert.deepEqual(carryConsent(CONSENT, C2 ?? {}), { state: "current" });
  assert.deepEqual(carryConsent(CONSENT, { version: 5, fingerprint: C2?.fingerprint }), { state: "current" }, "版本号表里没有、条目和当前一样");
  assert.equal(carryConsent(CONSENT, {}).state, "needed");
});
