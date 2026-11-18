// 同意表、启用说明和指纹，以及传输层、查模型能力按版本加指纹的核对。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CAPABILITY_STORAGE_KEY,
  createCapabilityResolver,
  createConsentGuardedGetter,
  createJsonGetter,
  type JsonResponse,
} from "../../../src/core/ai/capabilities.ts";
import { PROTOCOLS } from "../../../src/core/ai/provider/index.ts";
import {
  aiErrorResponse,
  createAiTransport,
  type AiFetch,
  type AiTransportDeps,
  type TransportError,
  type TransportResponse,
} from "../../../src/core/ai/transport/index.ts";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_TABLE,
  ACTIVATION_VERSION,
  BUILD_FEATURES,
  currentStamp,
  DATA_CONSENT_ERROR,
  DATA_CONSENT_FINGERPRINT,
  DATA_CONSENT_TABLE,
  DATA_CONSENT_VERSION,
  dataConsentGiven,
  noticeLines,
  noticeStatus,
  versionStamps,
  type NoticeItem,
  type NoticeTable,
} from "../../../src/core/consent.ts";
import * as SETTINGS from "../../../src/shared/settings-schema.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

const OLD_FINGERPRINT = "0000000000000000";
const MESSAGES = [{ role: "user", content: "你好" }];
const FRAME_OFF = { frameExplain: false } as const;
const FRAME_ON = { frameExplain: true } as const;

const CONFIGURED = {
  presetId: "custom",
  protocol: PROTOCOLS.OPENAI,
  aiBaseUrl: "https://api.example.com/v1",
  aiApiKey: "test-key",
  aiModel: "test-model",
  ...SETTINGS.DATA_CONSENT_CONFIRMED,
};

const ANTHROPIC = {
  presetId: "anthropic",
  aiApiKey: "sk-ant-test",
  aiApiKeyOrigin: "https://api.anthropic.com/",
  aiModel: "claude-sonnet-5-5",
  ...SETTINGS.DATA_CONSENT_CONFIRMED,
};

const openaiReply = (content: string, extra: Readonly<Record<string, unknown>> = {}): TransportResponse => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content }, ...extra }] }),
});

const MODEL_PAGE = (id: string): JsonResponse => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id, type: "model" }], has_more: true, first_id: id, last_id: id }),
});

const failureOf = (pending: Promise<unknown>): Promise<TransportError> =>
  pending.then(
    () => assert.fail("应当报错"),
    (error: TransportError) => error,
  );

function makeTransport(fetchImpl: AiFetch, overrides: Partial<AiTransportDeps> = {}) {
  return createAiTransport({
    getSettings: async () => SETTINGS.normalize(CONFIGURED),
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    ...overrides,
    fetch: fetchImpl,
  });
}

function item<Kind extends string>(kind: Kind, id: string, text = `${id} 的说明`): NoticeItem<Kind> {
  return { kind, id, text };
}

const ids = (items: readonly NoticeItem<string>[]): string[] => items.map(({ id }) => id);

const versionMap = (table: NoticeTable<string>, frameExplain: boolean): Record<string, string> =>
  Object.fromEntries(versionStamps(table, { frameExplain }).map(({ version, fingerprint }) => [String(version), fingerprint]));

// 第 1 版带一条普通内容，第 2 版只在开关打开时才有，第 3 版是之后的普通内容。
const GATED_TABLE: NoticeTable<"category" | "trigger"> = [
  { version: 1, items: [item("category", "transcript"), item("trigger", "on-click")] },
  { version: 2, items: [{ ...item("category", "frame"), requires: "frameExplain" }] },
  { version: 3, items: [item("trigger", "auto-send")] },
];

test("有密钥但没确认数据说明时校验不过，AI 请求一个都不发", async () => {
  const fetched: string[] = [];
  const permissions: string[] = [];
  let lookups = 0;
  const stored = SETTINGS.normalize({ ...CONFIGURED, dataConsentVersion: 0, dataConsentFingerprint: "" });

  const check = SETTINGS.validate(stored);
  assert.equal(check.ok, false);
  assert.deepEqual(check.errors, [DATA_CONSENT_ERROR]);

  const transport = makeTransport(
    async (url) => {
      fetched.push(url);
      return openaiReply("不该发出");
    },
    {
      getSettings: async () => stored,
      ensureHostPermission: async (baseUrl) => permissions.push(baseUrl),
      getModelCapabilities: async () => {
        lookups += 1;
        return null;
      },
    },
  );

  const error = await failureOf(transport.requestAiCompletion({ feature: "explain", messages: MESSAGES, maxTokens: 100 }));
  const reply = aiErrorResponse(error);
  assert.equal(reply.success, false);
  assert.equal(reply.error, "NO_AI_CONFIG");
  assert.ok(error.message.includes(DATA_CONSENT_ERROR), "说的是同意的问题，不是密钥的问题");
  assert.deepEqual(fetched, []);
  assert.deepEqual(permissions, [], "没确认时不申请域名权限");
  assert.equal(lookups, 0, "没确认时不查模型能力");
});

test("版本相同、说明指纹对不上：传输层按没确认拦下，一个请求都不发", async () => {
  const blocked = (error: TransportError): boolean =>
    error.code === "NO_AI_CONFIG" && error.message.includes(DATA_CONSENT_ERROR);

  // 配置校验放行时，发出之前的核对也要比指纹。
  for (const fingerprint of [OLD_FINGERPRINT, "", undefined]) {
    let sends = 0;
    const transport = makeTransport(
      async () => {
        sends += 1;
        return openaiReply("不该发出");
      },
      {
        getSettings: async () => SETTINGS.normalize({ ...CONFIGURED, dataConsentFingerprint: fingerprint }),
        settingsRules: { ...SETTINGS.settingsRules, validate: () => ({ ok: true, errors: [] }) },
      },
    );
    await assert.rejects(() => transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }), blocked);
    assert.equal(sends, 0, `指纹 ${String(fingerprint)}`);
  }

  // 开头的校验读到的对得上，查模型能力的工夫说明换了：第一次请求也不发。
  let fingerprint = DATA_CONSENT_FINGERPRINT;
  let sends = 0;
  const midway = makeTransport(
    async () => {
      sends += 1;
      return openaiReply("不该发出");
    },
    {
      getSettings: async () => SETTINGS.normalize({ ...CONFIGURED, dataConsentFingerprint: fingerprint }),
      getModelCapabilities: async () => {
        fingerprint = OLD_FINGERPRINT;
        return null;
      },
    },
  );
  await assert.rejects(() => midway.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }), blocked);
  assert.equal(sends, 0);

  // 已经发出的那次照常回来，之后的加码重试不再发，不多计费。
  fingerprint = DATA_CONSENT_FINGERPRINT;
  sends = 0;
  const retrying = makeTransport(
    async () => {
      sends += 1;
      fingerprint = OLD_FINGERPRINT;
      return openaiReply("", { finish_reason: "length" });
    },
    { getSettings: async () => SETTINGS.normalize({ ...CONFIGURED, dataConsentFingerprint: fingerprint }) },
  );
  await assert.rejects(() => retrying.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 }), blocked);
  assert.equal(sends, 1, "只发了说明变化之前的那一次");
});

test("版本相同、说明指纹对不上：查模型能力一页也不翻", async () => {
  const urls: string[] = [];
  let fingerprint = OLD_FINGERPRINT;
  const getSettings = async () => SETTINGS.normalize({ ...ANTHROPIC, dataConsentFingerprint: fingerprint });
  const storage = memoryStorage();
  const resolve = createCapabilityResolver({
    storage,
    send: createConsentGuardedGetter({
      getSettings,
      settingsRules: SETTINGS.settingsRules,
      send: createJsonGetter(async (url) => {
        urls.push(url);
        fingerprint = OLD_FINGERPRINT;
        return MODEL_PAGE(`model-${urls.length}`);
      }),
    }),
  });
  const settings = SETTINGS.normalize(ANTHROPIC);

  await assert.rejects(() => resolve(settings), { code: "NO_DATA_CONSENT", message: DATA_CONSENT_ERROR });
  assert.deepEqual(urls, []);
  assert.equal(Object.hasOwn(storage.data, CAPABILITY_STORAGE_KEY), false, "同意的问题不算服务出错，不记一次失败");

  // 第一页的路上说明换了：后面的页不再请求。
  fingerprint = DATA_CONSENT_FINGERPRINT;
  await assert.rejects(() => resolve(settings), { code: "NO_DATA_CONSENT" });
  assert.equal(urls.length, 1);
  assert.equal(Object.hasOwn(storage.data, CAPABILITY_STORAGE_KEY), false);
});

test("版本和指纹都对得上才放行，传输层照常发", async () => {
  let sends = 0;
  const transport = makeTransport(async () => {
    sends += 1;
    return openaiReply("回复");
  });
  const { text } = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100 });
  assert.equal(text, "回复");
  assert.equal(sends, 1);
});

test("数据同意的核对：版本、指纹差一样都不放行，规则不完整时一律不放行", () => {
  const rules = { dataConsentVersion: 2, dataConsentFingerprint: "当前指纹" };
  const given = (version: unknown, fingerprint: unknown): boolean =>
    dataConsentGiven({ dataConsentVersion: version, dataConsentFingerprint: fingerprint }, rules);

  assert.equal(given(2, "当前指纹"), true);
  assert.equal(given(1, "当前指纹"), false);
  assert.equal(given(3, "当前指纹"), false);
  assert.equal(given(0, "当前指纹"), false);
  assert.equal(given("2", "当前指纹"), false);
  assert.equal(given(2, "旧指纹"), false);
  assert.equal(given(2, ""), false);
  assert.equal(given(2, undefined), false);
  assert.equal(dataConsentGiven({}, rules), false);

  assert.equal(dataConsentGiven({ dataConsentVersion: 0, dataConsentFingerprint: "" }, { dataConsentVersion: 0, dataConsentFingerprint: "" }), false);
  assert.equal(dataConsentGiven({ dataConsentVersion: 2, dataConsentFingerprint: "" }, { dataConsentVersion: 2, dataConsentFingerprint: "" }), false);
});

// 快照只往后加：条目有实质变化就在表里加一版，在快照里加一行，已有的行不动。
// 只有还没人确认过的草稿版本，才可以连同快照一起改。
test("「版本 → 指纹」快照：改了条目没升版就失败，两种开关状态各一份", () => {
  const snapshot = JSON.parse(
    readFileSync(new URL("../../fixtures/consent-fingerprints.json", import.meta.url), "utf8"),
  ) as Record<string, { dataConsent: Record<string, string>; activation: Record<string, string> }>;

  assert.deepEqual(Object.keys(snapshot), ["frameExplainOff", "frameExplainOn"]);
  assert.deepEqual(versionMap(DATA_CONSENT_TABLE, false), snapshot["frameExplainOff"]?.dataConsent);
  assert.deepEqual(versionMap(ACTIVATION_TABLE, false), snapshot["frameExplainOff"]?.activation);
  assert.deepEqual(versionMap(DATA_CONSENT_TABLE, true), snapshot["frameExplainOn"]?.dataConsent);
  assert.deepEqual(versionMap(ACTIVATION_TABLE, true), snapshot["frameExplainOn"]?.activation);
});

test("解释当前画面：开关打开的构建，两份说明的当前一版各多几条，版本号不变；关着的构建里没有这几条", () => {
  const gated = (table: NoticeTable<string>): string[] =>
    table.flatMap((row) => row.items.filter((entry) => entry.requires === "frameExplain").map(({ kind, id }) => `${row.version} ${kind}:${id}`));
  assert.deepEqual(gated(ACTIVATION_TABLE), ["3 read:current-frame"]);
  assert.deepEqual(gated(DATA_CONSENT_TABLE), ["5 category:current-frame", "5 purpose:frame-explain"]);
  for (const table of [ACTIVATION_TABLE, DATA_CONSENT_TABLE] as NoticeTable<string>[]) {
    const off = versionStamps(table, FRAME_OFF);
    const on = versionStamps(table, FRAME_ON);
    assert.deepEqual(on.map(({ version }) => version), off.map(({ version }) => version), "不另开一版");
    assert.deepEqual(on.slice(0, -1), off.slice(0, -1), "之前几版两种构建一样");
    assert.notEqual(on.at(-1)?.fingerprint, off.at(-1)?.fingerprint, "当前一版的指纹变了，确认过的人要再确认一次");
  }

  // 在开关关着的构建里确认过当前一版的人，换到开关打开的构建：说明有更新，要重新确认。
  const lastOff = versionStamps(ACTIVATION_TABLE, FRAME_OFF).at(-1);
  const status = noticeStatus(ACTIVATION_TABLE, { version: lastOff?.version, fingerprint: lastOff?.fingerprint }, FRAME_ON);
  assert.equal(status.state === "needed" && status.updated, true);
  assert.ok(status.state === "needed" && status.items.some(({ id }) => id === "current-frame"));
  // 数据说明里截图这一条和划词解释那些功能并成一行显示。
  const lines = noticeLines(DATA_CONSENT_TABLE.flatMap((row) => row.items));
  assert.ok(lines.some((line) => line.ids.includes("ai-features") && line.ids.includes("frame-explain") && line.text.endsWith("解释当前画面")));
});

test("当前版本和指纹取自表里最新的一版，启用说明从第 1 版起", () => {
  assert.deepEqual(currentStamp(DATA_CONSENT_TABLE, BUILD_FEATURES), {
    version: DATA_CONSENT_VERSION,
    fingerprint: DATA_CONSENT_FINGERPRINT,
  });
  assert.deepEqual(currentStamp(ACTIVATION_TABLE, BUILD_FEATURES), {
    version: ACTIVATION_VERSION,
    fingerprint: ACTIVATION_FINGERPRINT,
  });
  assert.equal(ACTIVATION_TABLE[0]?.version, 1);
  assert.notEqual(DATA_CONSENT_FINGERPRINT, ACTIVATION_FINGERPRINT);
});

test("两张表：版本从小到大，每版都有条目，同一张表里条目不重复，措辞都写了", () => {
  const check = (table: NoticeTable<string>): void => {
    const seen = new Set<string>();
    let last = 0;
    for (const row of table) {
      assert.ok(Number.isInteger(row.version) && row.version > last, `版本 ${row.version}`);
      last = row.version;
      assert.ok(row.items.length > 0, `版本 ${row.version} 没有条目`);
      for (const { kind, id, text } of row.items) {
        assert.match(id, /^[a-z][a-z-]*$/);
        assert.ok(text.trim(), `${kind}:${id} 没写措辞`);
        assert.equal(seen.has(`${kind}:${id}`), false, `${kind}:${id} 重复了`);
        seen.add(`${kind}:${id}`);
      }
    }
  };
  check(DATA_CONSENT_TABLE);
  check(ACTIVATION_TABLE);

  const kinds = (table: NoticeTable<string>): string[] => [...new Set(table.flatMap((row) => row.items.map(({ kind }) => kind)))].sort();
  assert.deepEqual(kinds(DATA_CONSENT_TABLE), ["category", "purpose", "recipient", "trigger"]);
  assert.deepEqual(kinds(ACTIVATION_TABLE), ["purpose", "read", "store"]);
});

test("指纹只看条目：改措辞、调顺序不变，增删或改 id、kind 都会变", () => {
  const base: NoticeTable<"category" | "trigger"> = [{ version: 1, items: [item("category", "a"), item("trigger", "b")] }];
  const fingerprint = (table: NoticeTable<string>): string => currentStamp(table, FRAME_OFF).fingerprint;

  assert.equal(fingerprint([{ version: 1, items: [item("category", "a", "换了说法"), item("trigger", "b", "也换了")] }]), fingerprint(base));
  assert.equal(fingerprint([{ version: 1, items: [item("trigger", "b"), item("category", "a")] }]), fingerprint(base));
  assert.equal(fingerprint([{ version: 1, items: [item("category", "a")] }, { version: 2, items: [item("trigger", "b")] }]), fingerprint(base));

  assert.notEqual(fingerprint([{ version: 1, items: [item("category", "a")] }]), fingerprint(base));
  assert.notEqual(fingerprint([{ version: 1, items: [item("category", "a"), item("trigger", "c")] }]), fingerprint(base));
  assert.notEqual(fingerprint([{ version: 1, items: [item("trigger", "a"), item("trigger", "b")] }]), fingerprint(base));
  assert.notEqual(fingerprint([{ version: 1, items: [...base[0]?.items ?? [], item("trigger", "c")] }]), fingerprint(base));
});

test("每一版的指纹覆盖到这一版为止的全部条目，加新版不改旧版的指纹", () => {
  const [first, second] = versionStamps(DATA_CONSENT_TABLE, FRAME_OFF);
  assert.deepEqual(versionStamps(DATA_CONSENT_TABLE.slice(0, 1), FRAME_OFF), [first]);
  assert.notEqual(first?.fingerprint, second?.fingerprint);
});

test("没存过的显示完整说明，算从没同意过，不是说明有更新", () => {
  const everything = DATA_CONSENT_TABLE.flatMap((row) => row.items).filter((entry) => !entry.requires);
  for (const stored of [{}, { version: 0, fingerprint: "" }, { version: -1 }, { version: null }]) {
    assert.deepEqual(noticeStatus(DATA_CONSENT_TABLE, stored, FRAME_OFF), { state: "needed", updated: false, items: everything });
  }
});

test("存过当前版本和指纹的放行，这才算确认过", () => {
  const current = { version: DATA_CONSENT_VERSION, fingerprint: DATA_CONSENT_FINGERPRINT };
  assert.deepEqual(noticeStatus(DATA_CONSENT_TABLE, current, BUILD_FEATURES), { state: "current" });
  const enabled = { version: ACTIVATION_VERSION, fingerprint: ACTIVATION_FINGERPRINT };
  assert.deepEqual(noticeStatus(ACTIVATION_TABLE, enabled, BUILD_FEATURES), { state: "current" });
});

test("存过旧版本的只列之后新增的内容", () => {
  const [first] = versionStamps(DATA_CONSENT_TABLE, FRAME_OFF);
  assert.ok(first);
  const status = noticeStatus(DATA_CONSENT_TABLE, first, FRAME_OFF);
  assert.equal(status.state, "needed");
  assert.ok(status.state === "needed" && status.updated);
  assert.deepEqual(status.state === "needed" ? ids(status.items) : [], ["imported-transcript", "video-duration", "auto-on-open", "tidy-transcript"]);
});

// 数据同意第 3 版：发给模型的视频信息多了时长。完整说明里和「视频标题」并成一行显示，指纹按新增的语义条目算。
const [CONSENT_V1, CONSENT_V2, CONSENT_V3] = versionStamps(DATA_CONSENT_TABLE, FRAME_OFF);
const lines = (items: readonly NoticeItem<string>[]) => noticeLines(items).map(({ ids: lineIds, text }) => ({ ids: lineIds, text }));

test("数据同意第 3 版加了视频时长：第 1、2 版的指纹不变，第 3 版的指纹是快照里那一份", () => {
  assert.deepEqual(versionStamps(DATA_CONSENT_TABLE, FRAME_OFF).slice(0, 3), [
    { version: 1, fingerprint: "b77f44c06d527713" },
    { version: 2, fingerprint: "3bba6112484a07d2" },
    { version: 3, fingerprint: "7388613d751dad34" },
  ]);
  assert.deepEqual(DATA_CONSENT_TABLE[2]?.items.map(({ kind, id }) => `${kind}:${id}`), ["category:video-duration"]);
});

// 数据同意第 4 版：从「点了才发」变成打开就出结论时自动发，超出原来的范围，升版重新同意。
test("数据同意第 4 版加了打开视频就自动发送：前三版的指纹不变，两种构建一样", () => {
  assert.deepEqual(versionStamps(DATA_CONSENT_TABLE, FRAME_OFF)[3], { version: 4, fingerprint: "16a09b86eba35d2e" });
  assert.deepEqual(versionStamps(DATA_CONSENT_TABLE, FRAME_ON)[3], { version: 4, fingerprint: "16a09b86eba35d2e" });
  assert.deepEqual(DATA_CONSENT_TABLE[3]?.items.map(({ kind, id }) => `${kind}:${id}`), ["trigger:auto-on-open"]);
  assert.ok(CONSENT_V3);
  const stored = { dataConsentVersion: CONSENT_V3.version, dataConsentFingerprint: CONSENT_V3.fingerprint };
  assert.equal(dataConsentGiven(stored, { dataConsentVersion: DATA_CONSENT_VERSION, dataConsentFingerprint: DATA_CONSENT_FINGERPRINT }), false, "同意过第 3 版的要重新同意");
});

test("数据同意第 5 版加了整理字幕这个用途：前四版的指纹不变，第 5 版是当前一版；同意过第 4 版的要重新同意，只看到这一行", () => {
  const stamps = versionStamps(DATA_CONSENT_TABLE, FRAME_OFF);
  assert.deepEqual(stamps.at(-1), { version: 5, fingerprint: "5ccabe99b2185669" });
  assert.equal(currentStamp(DATA_CONSENT_TABLE, FRAME_ON).version, 5, "解释当前画面的几条并进第 5 版，不另开一版");
  assert.equal(DATA_CONSENT_VERSION, 5);
  assert.deepEqual(
    DATA_CONSENT_TABLE.at(-1)?.items.filter((entry) => !entry.requires).map(({ kind, id }) => `${kind}:${id}`),
    ["purpose:tidy-transcript"],
  );
  const fourth = stamps[3];
  assert.ok(fourth);
  assert.equal(dataConsentGiven({ dataConsentVersion: fourth.version, dataConsentFingerprint: fourth.fingerprint }, { dataConsentVersion: DATA_CONSENT_VERSION, dataConsentFingerprint: DATA_CONSENT_FINGERPRINT }), false);
  const fromFourth = noticeStatus(DATA_CONSENT_TABLE, fourth, FRAME_OFF);
  assert.ok(fromFourth.state === "needed" && fromFourth.updated);
  const [only, ...rest] = lines(fromFourth.items);
  assert.equal(rest.length, 0);
  assert.deepEqual(only?.ids, ["tidy-transcript"]);
  for (const word of ["整理字幕", "补标点", "同音错字", "点「整理字幕」时"]) assert.ok(only?.text.includes(word), word);
  // 完整说明里和用途那一行并成一行。
  const full = lines(DATA_CONSENT_TABLE.flatMap((row) => row.items).filter((entry) => !entry.requires));
  const purpose = full.find((line) => line.ids.includes("ai-features"));
  assert.deepEqual(purpose?.ids, ["ai-features", "tidy-transcript"]);
  assert.match(purpose?.text ?? "", /整理字幕（补标点、改同音错字）/);
});

test("第 4 版的说明：同意过第 3 版的只看到自动发送这一行；完整说明里它和「只在你点按钮时发出」并成一行", () => {
  const fromThird = noticeStatus(DATA_CONSENT_TABLE, CONSENT_V3 ?? {}, FRAME_OFF);
  assert.ok(fromThird.state === "needed" && fromThird.updated);
  const [only] = lines(fromThird.items);
  assert.deepEqual(only?.ids, ["auto-on-open"]);
  assert.match(only?.text ?? "", /^打开「打开就出结论」以后/);
  for (const word of ["字幕", "视频标题和时长", "UP 主名和简介", "超过设定时长", "YouTube 不自动发"]) assert.ok(only?.text.includes(word), word);

  const full = noticeStatus(DATA_CONSENT_TABLE, {}, FRAME_OFF);
  assert.ok(full.state === "needed");
  const trigger = noticeLines(full.items).filter((line) => line.kind === "trigger");
  assert.deepEqual(trigger.map((line) => line.ids), [["on-click", "auto-on-open"]]);
  assert.match(trigger[0]?.text ?? "", /^平时只在你点按钮时发出；打开「打开就出结论」以后/);
});

test("只把「视频标题」的措辞改成「视频标题和时长」、不加条目：第 2 版的同意照样算数，所以光改文字不够", () => {
  const reworded: NoticeTable<string> = DATA_CONSENT_TABLE.slice(0, 2).map((row) => ({
    ...row,
    items: row.items.map((entry) => (entry.id === "video-title" ? { ...entry, text: "视频标题和时长" } : entry)),
  }));
  assert.deepEqual(noticeStatus(reworded, CONSENT_V2 ?? {}, FRAME_OFF), { state: "current" });
});

test("存着第 2 版的同意：当前规则下不算同意，提示说明有更新，模型请求不放行", () => {
  assert.ok(CONSENT_V2);
  const status = noticeStatus(DATA_CONSENT_TABLE, CONSENT_V2, FRAME_OFF);
  assert.equal(status.state, "needed");
  assert.ok(status.state === "needed" && status.updated);
  const stored = { dataConsentVersion: CONSENT_V2.version, dataConsentFingerprint: CONSENT_V2.fingerprint };
  assert.equal(dataConsentGiven(stored, { dataConsentVersion: DATA_CONSENT_VERSION, dataConsentFingerprint: DATA_CONSENT_FINGERPRINT }), false);
});

test("更新提示：第 2 版的同意者看到新增的「视频时长」、自动发送和整理字幕，第 1 版的同意者再多看到导入字幕", () => {
  const fromSecond = noticeStatus(DATA_CONSENT_TABLE, CONSENT_V2 ?? {}, FRAME_OFF);
  assert.ok(fromSecond.state === "needed");
  assert.deepEqual(ids(fromSecond.items), ["video-duration", "auto-on-open", "tidy-transcript"]);
  assert.deepEqual(lines(fromSecond.items)[0], { ids: ["video-duration"], text: "视频时长" });

  const fromFirst = noticeStatus(DATA_CONSENT_TABLE, CONSENT_V1 ?? {}, FRAME_OFF);
  assert.ok(fromFirst.state === "needed");
  assert.deepEqual(ids(fromFirst.items), ["imported-transcript", "video-duration", "auto-on-open", "tidy-transcript"]);
  assert.deepEqual(lines(fromFirst.items).slice(0, 2).map(({ text }) => text), ["你导入的字幕文件里的文字", "视频时长"]);
});

test("完整说明：从没同意过的人看到「视频标题和时长」一行，带两个条目，没有单独的「视频时长」", () => {
  const status = noticeStatus(DATA_CONSENT_TABLE, {}, FRAME_OFF);
  assert.ok(status.state === "needed" && !status.updated);
  const shown = lines(status.items);
  assert.equal(shown.length, status.items.length - 3, "时长并进标题，自动发送并进点了才发，整理字幕并进用途");
  assert.deepEqual(shown.find(({ text }) => text === "视频标题和时长"), { ids: ["video-title", "video-duration"], text: "视频标题和时长" });
  assert.equal(shown.some(({ text }) => text === "视频时长"), false);
  assert.equal(shown.some(({ text }) => text === "视频标题"), false);
  assert.deepEqual(shown.flatMap(({ ids: lineIds }) => lineIds).sort(), ids(status.items).sort(), "每个条目都在某一行里");
});

test("并显示只能指向同一张表更早版本里同一类的条目，被指向的条目自己不再并到别处", () => {
  for (const table of [DATA_CONSENT_TABLE, ACTIVATION_TABLE] as readonly NoticeTable<string>[]) {
    table.forEach((row, index) => {
      for (const entry of row.items) {
        if (!entry.shownWith) continue;
        const earlier = table.slice(0, index).flatMap((previous) => previous.items);
        const target = earlier.find((candidate) => candidate.kind === entry.kind && candidate.id === entry.shownWith?.id);
        assert.ok(target, `${entry.kind}:${entry.id} 指向的条目不在更早的版本里`);
        assert.equal(target.shownWith, undefined, `${entry.kind}:${entry.id} 指向的条目自己也要并到别处`);
        assert.ok(entry.shownWith.combined.trim(), `${entry.kind}:${entry.id} 没写合成的措辞`);
      }
    });
  }
});

test("加上或去掉并显示的写法，指纹都不变", () => {
  const plain = DATA_CONSENT_TABLE.map((row) => ({ ...row, items: row.items.map(({ kind, id, text, requires }) => ({ kind, id, text, ...(requires ? { requires } : {}) })) }));
  assert.deepEqual(versionStamps(plain, FRAME_OFF), versionStamps(DATA_CONSENT_TABLE, FRAME_OFF));
  const extra: NoticeTable<string> = DATA_CONSENT_TABLE.map((row) => ({
    ...row,
    items: row.items.map((entry) => (entry.id === "selection" ? { ...entry, shownWith: { id: "question", combined: "选中的文字和问题" } } : entry)),
  }));
  assert.deepEqual(versionStamps(extra, FRAME_OFF), versionStamps(DATA_CONSENT_TABLE, FRAME_OFF));
});

test("启用说明第 2 版加了 B 站登录状态和稍后再看的观看进度：确认过第 1 版的只看到新增的几条，第 1 版的指纹不变", () => {
  const [first, second] = versionStamps(ACTIVATION_TABLE, FRAME_OFF);
  assert.deepEqual(first, { version: 1, fingerprint: "ea809e9a65f8b633" });
  assert.deepEqual(second, { version: 2, fingerprint: "b43642643fe4e6e5" });
  assert.ok(first);
  const status = noticeStatus(ACTIVATION_TABLE, first, FRAME_OFF);
  assert.ok(status.state === "needed" && status.updated);
  assert.deepEqual(status.state === "needed" ? ids(status.items) : [], ["bili-login-state", "watch-later-progress", "foreground-tab"]);
  assert.ok(status.state === "needed" && status.items.every((entry) => entry.kind === "read"));
});

// 启用说明第 3 版：打开就出结论要后台看前台标签页的地址，读取范围扩大了，升版重新确认。
test("启用说明第 3 版加了前台标签页的地址：确认过第 2 版的只看到这一条，前两版的指纹不变", () => {
  const stamps = versionStamps(ACTIVATION_TABLE, FRAME_OFF);
  assert.deepEqual(stamps.at(-1), { version: 3, fingerprint: "32a7ecce69a08c6a" });
  assert.equal(currentStamp(ACTIVATION_TABLE, FRAME_OFF).version, 3, "发行构建停在第 3 版");
  const second = stamps[1];
  assert.ok(second);
  const status = noticeStatus(ACTIVATION_TABLE, second, FRAME_OFF);
  assert.ok(status.state === "needed" && status.updated);
  assert.deepEqual(status.state === "needed" ? status.items.map(({ kind, id }) => `${kind}:${id}`) : [], ["read:foreground-tab"]);
  assert.match(status.state === "needed" ? (status.items[0]?.text ?? "") : "", /打开就出结论.*前台标签页的地址/);
});

test("版本相同指纹不同、认不出的版本：确认失效，认不出同意过什么就显示完整说明", () => {
  const cases: readonly [NoticeTable<string>, number, string][] = [
    [DATA_CONSENT_TABLE, DATA_CONSENT_VERSION, DATA_CONSENT_FINGERPRINT],
    [ACTIVATION_TABLE, ACTIVATION_VERSION, ACTIVATION_FINGERPRINT],
  ];
  for (const [table, version, fingerprint] of cases) {
    const everything = table.flatMap((row) => row.items);
    const expected = { state: "needed", updated: true, items: everything };
    assert.deepEqual(noticeStatus(table, { version, fingerprint: OLD_FINGERPRINT }, BUILD_FEATURES), expected);
    assert.deepEqual(noticeStatus(table, { version, fingerprint: "" }, BUILD_FEATURES), expected);
    assert.deepEqual(noticeStatus(table, { version }, BUILD_FEATURES), expected);
    assert.deepEqual(noticeStatus(table, { version: version + 1, fingerprint }, BUILD_FEATURES), expected);
  }
  assert.equal(noticeStatus(DATA_CONSENT_TABLE, { version: "2", fingerprint: DATA_CONSENT_FINGERPRINT }, BUILD_FEATURES).state, "needed");
});

test("带开关的版本只在开关打开时进说明和指纹，关着的构建停在不含它的版本", () => {
  const onlyGated = GATED_TABLE.slice(0, 2);
  const off = versionStamps(onlyGated, FRAME_OFF);
  const on = versionStamps(onlyGated, FRAME_ON);
  assert.deepEqual(off.map(({ version }) => version), [1]);
  assert.deepEqual(on.map(({ version }) => version), [1, 2]);
  assert.equal(on[0]?.fingerprint, off[0]?.fingerprint, "不含开关条目的那一版，两种构建的指纹一样");
  assert.deepEqual(currentStamp(onlyGated, FRAME_OFF), off[0]);
  assert.deepEqual(currentStamp(onlyGated, FRAME_ON), on[1]);

  // 开关之后又加了一版：两种构建都有第 3 版，指纹不同，换构建要重新确认。
  const third = (features: typeof FRAME_OFF | typeof FRAME_ON) => versionStamps(GATED_TABLE, features).at(-1);
  assert.equal(third(FRAME_OFF)?.version, 3);
  assert.equal(third(FRAME_ON)?.version, 3);
  assert.notEqual(third(FRAME_OFF)?.fingerprint, third(FRAME_ON)?.fingerprint);
});

test("确认过不含开关条目的旧说明，开关打开后只列新增的那一条，确认之前不算数", () => {
  const onlyGated = GATED_TABLE.slice(0, 2);
  const agreed = currentStamp(onlyGated, FRAME_OFF);
  assert.deepEqual(noticeStatus(onlyGated, agreed, FRAME_OFF), { state: "current" });

  const status = noticeStatus(onlyGated, agreed, FRAME_ON);
  assert.equal(status.state, "needed");
  assert.deepEqual(status.state === "needed" ? [status.updated, ids(status.items)] : [], [true, ["frame"]]);

  // 反过来，确认过带开关条目的说明，换到开关关着的构建：这个构建认不出那一版，显示完整说明。
  const newer = currentStamp(onlyGated, FRAME_ON);
  const back = noticeStatus(onlyGated, newer, FRAME_OFF);
  assert.deepEqual(back.state === "needed" ? [back.updated, ids(back.items)] : [], [true, ["transcript", "on-click"]]);
});
