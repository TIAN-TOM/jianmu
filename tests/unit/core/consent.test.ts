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
import { COMMENT_ACTIVATION_ITEMS, COMMENT_DATA_ITEMS } from "../../../src/core/consent-comments.ts";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_TABLE,
  ACTIVATION_VERSION,
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
  return { kind, id, text, en: `${id} notice` };
}

const ids = (items: readonly NoticeItem<string>[]): string[] => items.map(({ id }) => id);

const versionMap = (table: NoticeTable<string>): Record<string, string> =>
  Object.fromEntries(versionStamps(table).map(({ version, fingerprint }) => [String(version), fingerprint]));

// 评论区那几条只在日用包里（构建开关 FEATURE_COMMENTS，发行构建关着），单独成第 2 版；测试构建打开了它。去掉它们就是发行包的说明。
const COMMENT_KEYS: ReadonlySet<string> = new Set([...COMMENT_DATA_ITEMS, ...COMMENT_ACTIVATION_ITEMS].map(({ kind, id }) => `${kind}:${id}`));
const releaseOf = <Kind extends string>(table: NoticeTable<Kind>): NoticeTable<Kind> =>
  table.map((row) => ({ ...row, items: row.items.filter(({ kind, id }) => !COMMENT_KEYS.has(`${kind}:${id}`)) })).filter((row) => row.items.length > 0);

test("有密钥但没确认数据说明时校验不过，AI 请求一个都不发", async () => {
  const fetched: string[] = [];
  const permissions: string[] = [];
  let lookups = 0;
  const stored = SETTINGS.normalize({ ...CONFIGURED, dataConsentVersion: 0, dataConsentFingerprint: "" });

  const check = SETTINGS.validate(stored, "zh");
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

  const error = await failureOf(transport.requestAiCompletion({ feature: "explain", messages: MESSAGES, maxTokens: 100, lang: "zh" }));
  const reply = aiErrorResponse(error, "zh");
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
    await assert.rejects(() => transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, lang: "zh" }), blocked);
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
  await assert.rejects(() => midway.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, lang: "zh" }), blocked);
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
  await assert.rejects(() => retrying.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, lang: "zh" }), blocked);
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
  const { text } = await transport.requestAiCompletion({ messages: MESSAGES, maxTokens: 100, lang: "zh" });
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
test("「版本 → 指纹」快照：改了条目没升版就失败", () => {
  const snapshot = JSON.parse(
    readFileSync(new URL("../../fixtures/consent-fingerprints.json", import.meta.url), "utf8"),
  ) as { dataConsent: Record<string, string>; activation: Record<string, string> };

  assert.deepEqual(versionMap(releaseOf(DATA_CONSENT_TABLE)), snapshot.dataConsent);
  assert.deepEqual(versionMap(releaseOf(ACTIVATION_TABLE)), snapshot.activation);
});

const entryKeys = (items: readonly NoticeItem<string>[]): string[] => items.map(({ kind, id }) => `${kind}:${id}`);
const lines = (items: readonly NoticeItem<string>[]) => noticeLines(items, "zh").map(({ ids: lineIds, text }) => ({ ids: lineIds, text }));

// 首发前的版本号是开发期间留下的，首发的包从第 1 版算起，开发期间加过的条目都算第 1 版的内容（PRD 第 7.2、7.3 节）。
test("首发的两份说明都是第 1 版，表里只有这一版，开发期间加过的条目都在里面", () => {
  assert.deepEqual(currentStamp(releaseOf(DATA_CONSENT_TABLE)), { version: 1, fingerprint: "7c550f58c5fddf7f" });
  assert.deepEqual(currentStamp(releaseOf(ACTIVATION_TABLE)), { version: 1, fingerprint: "372b4707b69fb4f1" });
  assert.deepEqual(releaseOf(DATA_CONSENT_TABLE).map(({ version }) => version), [1]);
  assert.deepEqual(releaseOf(ACTIVATION_TABLE).map(({ version }) => version), [1]);
  // 测试构建开着评论区，多出只在日用包里的第 2 版。
  assert.equal(DATA_CONSENT_VERSION, 2);
  assert.equal(ACTIVATION_VERSION, 2);
  assert.deepEqual(entryKeys(DATA_CONSENT_TABLE.flatMap((row) => row.items)), [
    "category:transcript",
    "category:selection",
    "category:question",
    "category:video-title",
    "category:uploader-and-description",
    "category:official-summary",
    "category:api-key",
    "purpose:ai-features",
    "recipient:chosen-provider",
    "trigger:on-click",
    "category:imported-transcript",
    "category:video-duration",
    "trigger:auto-on-open-tabs",
    "purpose:tidy-transcript",
    "trigger:keep-running",
    "category:current-frame",
    "purpose:frame-explain",
    "category:top-comments",
  ]);
  assert.deepEqual(entryKeys(ACTIVATION_TABLE.flatMap((row) => row.items)), [
    "read:video-info",
    "read:transcript",
    "read:official-summary",
    "read:watch-state",
    "read:window-tabs",
    "read:watch-later",
    "purpose:display",
    "purpose:pick-mode",
    "purpose:material",
    "store:cache",
    "store:triage",
    "store:saved",
    "read:bili-login-state",
    "read:watch-later-progress",
    "read:open-tabs",
    "read:current-frame",
    "read:top-comments",
  ]);
});

test("评论区只在日用包里：两份说明各多一版，只有评论这一条，第 1 版的指纹不变；发行构建没有这一版", () => {
  const keys = (table: NoticeTable<string>): string[] => table.flatMap((row) => row.items.filter(({ id }) => id === "top-comments").map(({ kind, id }) => `${row.version} ${kind}:${id}`));
  assert.deepEqual(keys(DATA_CONSENT_TABLE), ["2 category:top-comments"]);
  assert.deepEqual(keys(ACTIVATION_TABLE), ["2 read:top-comments"]);
  assert.deepEqual(DATA_CONSENT_TABLE[1]?.items.length, 1);
  assert.deepEqual(ACTIVATION_TABLE[1]?.items.length, 1);
  assert.deepEqual(versionStamps(DATA_CONSENT_TABLE)[0], currentStamp(releaseOf(DATA_CONSENT_TABLE)), "第 1 版的指纹和发行包一样");
  assert.deepEqual(versionStamps(ACTIVATION_TABLE)[0], currentStamp(releaseOf(ACTIVATION_TABLE)));
  const shown = noticeLines(DATA_CONSENT_TABLE.flatMap((row) => row.items), "zh").find((line) => line.ids.includes("top-comments"));
  assert.ok(shown?.text.includes("不含昵称"));
});

test("解释当前画面首发带上：两份说明的第 1 版各多几条；截图这一条和划词解释那些功能并成一行显示", () => {
  const frameItems = (table: NoticeTable<string>): string[] =>
    table.flatMap((row) => row.items.filter(({ id }) => ["current-frame", "frame-explain"].includes(id)).map(({ kind, id }) => `${row.version} ${kind}:${id}`));
  assert.deepEqual(frameItems(ACTIVATION_TABLE), ["1 read:current-frame"]);
  assert.deepEqual(frameItems(DATA_CONSENT_TABLE), ["1 category:current-frame", "1 purpose:frame-explain"]);
  const shown = noticeLines(DATA_CONSENT_TABLE.flatMap((row) => row.items), "zh");
  assert.ok(shown.some((line) => line.ids.includes("ai-features") && line.ids.includes("frame-explain") && line.text.endsWith("解释当前画面")));
});

test("当前版本和指纹取自表里最新的一版，两份说明都从第 1 版起", () => {
  assert.deepEqual(currentStamp(DATA_CONSENT_TABLE), {
    version: DATA_CONSENT_VERSION,
    fingerprint: DATA_CONSENT_FINGERPRINT,
  });
  assert.deepEqual(currentStamp(ACTIVATION_TABLE), {
    version: ACTIVATION_VERSION,
    fingerprint: ACTIVATION_FINGERPRINT,
  });
  assert.equal(DATA_CONSENT_TABLE[0]?.version, 1);
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
  const fingerprint = (table: NoticeTable<string>): string => currentStamp(table).fingerprint;

  assert.equal(fingerprint([{ version: 1, items: [item("category", "a", "换了说法"), item("trigger", "b", "也换了")] }]), fingerprint(base));
  assert.equal(fingerprint([{ version: 1, items: [item("trigger", "b"), item("category", "a")] }]), fingerprint(base));
  assert.equal(fingerprint([{ version: 1, items: [item("category", "a")] }, { version: 2, items: [item("trigger", "b")] }]), fingerprint(base));

  assert.notEqual(fingerprint([{ version: 1, items: [item("category", "a")] }]), fingerprint(base));
  assert.notEqual(fingerprint([{ version: 1, items: [item("category", "a"), item("trigger", "c")] }]), fingerprint(base));
  assert.notEqual(fingerprint([{ version: 1, items: [item("trigger", "a"), item("trigger", "b")] }]), fingerprint(base));
  assert.notEqual(fingerprint([{ version: 1, items: [...base[0]?.items ?? [], item("trigger", "c")] }]), fingerprint(base));
});

// 以后扩大范围升到第 2 版时的样子：在当前的表后面加一版。
const NEXT_ITEM = item("category", "next-thing");
const BASE: NoticeTable<string> = releaseOf(DATA_CONSENT_TABLE);
const NEXT: NoticeTable<string> = [...BASE, { version: 2, items: [NEXT_ITEM] }];

test("每一版的指纹覆盖到这一版为止的全部条目，加新版不改旧版的指纹", () => {
  const [first, second] = versionStamps(NEXT);
  assert.deepEqual(first, currentStamp(BASE));
  assert.deepEqual(versionStamps(NEXT.slice(0, 1)), [first]);
  assert.notEqual(first?.fingerprint, second?.fingerprint);
});

test("没存过的显示完整说明，算从没同意过，不是说明有更新", () => {
  const everything = DATA_CONSENT_TABLE.flatMap((row) => row.items);
  for (const stored of [{}, { version: 0, fingerprint: "" }, { version: -1 }, { version: null }]) {
    assert.deepEqual(noticeStatus(DATA_CONSENT_TABLE, stored), { state: "needed", updated: false, items: everything });
  }
});

test("存过当前版本和指纹的放行，这才算确认过", () => {
  const current = { version: DATA_CONSENT_VERSION, fingerprint: DATA_CONSENT_FINGERPRINT };
  assert.deepEqual(noticeStatus(DATA_CONSENT_TABLE, current), { state: "current" });
  const enabled = { version: ACTIVATION_VERSION, fingerprint: ACTIVATION_FINGERPRINT };
  assert.deepEqual(noticeStatus(ACTIVATION_TABLE, enabled), { state: "current" });
});

test("说明更新时只列新增的内容：同意过第 1 版的，升到第 2 版只看到第 2 版加的条目，模型请求不放行", () => {
  const status = noticeStatus(NEXT, currentStamp(BASE));
  assert.ok(status.state === "needed" && status.updated, "提示说明有更新");
  assert.deepEqual(status.state === "needed" ? status.items : [], [NEXT_ITEM]);
  const next = currentStamp(NEXT);
  const stored = { dataConsentVersion: DATA_CONSENT_VERSION, dataConsentFingerprint: DATA_CONSENT_FINGERPRINT };
  assert.equal(dataConsentGiven(stored, { dataConsentVersion: next.version, dataConsentFingerprint: next.fingerprint }), false);
  assert.deepEqual(noticeStatus(NEXT, next), { state: "current" });
});

test("只列新增的内容时，并显示指向的那一条不在这组里就单列，用自己的措辞", () => {
  const table: NoticeTable<"category"> = [
    { version: 1, items: [item("category", "video-title", "视频标题")] },
    { version: 2, items: [{ kind: "category", id: "video-duration", text: "视频时长", en: "Video length", shownWith: { id: "video-title", combined: "视频标题和时长", combinedEn: "Video title and length" } }] },
  ];
  const [first] = versionStamps(table);
  const fromFirst = noticeStatus(table, first ?? {});
  assert.ok(fromFirst.state === "needed" && fromFirst.updated);
  assert.deepEqual(lines(fromFirst.items), [{ ids: ["video-duration"], text: "视频时长" }]);
  const full = noticeStatus(table, {});
  assert.ok(full.state === "needed" && !full.updated);
  assert.deepEqual(lines(full.items), [{ ids: ["video-title", "video-duration"], text: "视频标题和时长" }]);
});

test("完整说明：从没同意过的人看到「视频标题和时长」一行，带两个条目，没有单独的「视频时长」", () => {
  const status = noticeStatus(DATA_CONSENT_TABLE, {});
  assert.ok(status.state === "needed" && !status.updated);
  const shown = lines(status.items);
  assert.equal(shown.length, status.items.length - 4, "时长并进标题，自动发送并进点了才发，整理字幕和解释当前画面并进用途");
  assert.deepEqual(shown.find(({ text }) => text === "视频标题和时长"), { ids: ["video-title", "video-duration"], text: "视频标题和时长" });
  assert.equal(shown.some(({ text }) => text === "视频时长"), false);
  assert.equal(shown.some(({ text }) => text === "视频标题"), false);
  assert.deepEqual(shown.flatMap(({ ids: lineIds }) => lineIds).sort(), ids(status.items).sort(), "每个条目都在某一行里");
});

test("完整说明里的并显示：自动发送和「只在你点按钮时发出」并成一行，整理字幕和用途并成一行，关掉侧边栏也接着发另起一行", () => {
  const full = noticeStatus(DATA_CONSENT_TABLE, {});
  assert.ok(full.state === "needed");
  const trigger = noticeLines(full.items, "zh").filter((line) => line.kind === "trigger");
  assert.deepEqual(trigger.map((line) => line.ids), [["on-click", "auto-on-open-tabs"], ["keep-running"]]);
  assert.match(trigger[0]?.text ?? "", /^平时只在你点按钮时发出；打开「打开就出结论」以后/);
  for (const word of ["字幕", "视频标题和时长", "UP 主名或频道名和简介", "超过设定时长", "B 站和已启用的 YouTube"]) assert.ok(trigger[0]?.text.includes(word), word);
  for (const word of ["关掉侧边栏也继续", "API 额度", "点停止", "标签页换了视频或关掉"]) assert.ok(trigger[1]?.text.includes(word), word);
  const purpose = noticeLines(full.items, "zh").find((line) => line.ids.includes("ai-features"));
  assert.deepEqual(purpose?.ids, ["ai-features", "tidy-transcript", "frame-explain"]);
  assert.match(purpose?.text ?? "", /整理字幕（补标点、改同音错字）/);
});

test("并显示只能指向同一张表里排在它前面、同一类的条目，被指向的条目自己不再并到别处", () => {
  for (const table of [DATA_CONSENT_TABLE, ACTIVATION_TABLE] as readonly NoticeTable<string>[]) {
    const all = table.flatMap((row) => row.items);
    all.forEach((entry, index) => {
      if (!entry.shownWith) return;
      const target = all.slice(0, index).find((candidate) => candidate.kind === entry.kind && candidate.id === entry.shownWith?.id);
      assert.ok(target, `${entry.kind}:${entry.id} 指向的条目不在它前面`);
      assert.equal(target.shownWith, undefined, `${entry.kind}:${entry.id} 指向的条目自己也要并到别处`);
      assert.ok(entry.shownWith.combined.trim(), `${entry.kind}:${entry.id} 没写合成的措辞`);
    });
  }
});

test("加上或去掉并显示的写法，指纹都不变", () => {
  const plain = DATA_CONSENT_TABLE.map((row) => ({ ...row, items: row.items.map(({ kind, id, text, en }) => ({ kind, id, text, en })) }));
  assert.deepEqual(versionStamps(plain), versionStamps(DATA_CONSENT_TABLE));
  const extra: NoticeTable<string> = DATA_CONSENT_TABLE.map((row) => ({
    ...row,
    items: row.items.map((entry) => (entry.id === "selection" ? { ...entry, shownWith: { id: "question", combined: "选中的文字和问题", combinedEn: "Selected text and questions" } } : entry)),
  }));
  assert.deepEqual(versionStamps(extra), versionStamps(DATA_CONSENT_TABLE));
});

// 首发前开发期间存下的确认和同意：数据说明第 1 到 5 版、启用说明第 1 到 3 版，有的条目和现在一样只是版本号不同，有的是更早的指纹。
const EARLY_CONSENT = [
  { version: 5, fingerprint: DATA_CONSENT_FINGERPRINT },
  { version: 5, fingerprint: "b459474109f65107" },
  { version: 4, fingerprint: "6ac3269feba5a9cf" },
  { version: 3, fingerprint: "7388613d751dad34" },
  { version: 2, fingerprint: "3bba6112484a07d2" },
  { version: 1, fingerprint: "b77f44c06d527713" },
];
const EARLY_ACTIVATION = [
  { version: 3, fingerprint: ACTIVATION_FINGERPRINT },
  { version: 3, fingerprint: "c7c74de73be1ef90" },
  { version: 2, fingerprint: "b43642643fe4e6e5" },
  { version: 1, fingerprint: "ea809e9a65f8b633" },
];

test("首发前开发期间存下的版本号和旧指纹一律不认：要重新确认、重新同意，按第一次给完整说明，不提示说明有更新", () => {
  const cases: readonly [NoticeTable<string>, readonly { version: number; fingerprint: string }[]][] = [
    [DATA_CONSENT_TABLE, EARLY_CONSENT],
    [ACTIVATION_TABLE, EARLY_ACTIVATION],
  ];
  for (const [table, stamps] of cases) {
    const everything = table.flatMap((row) => row.items);
    for (const stored of stamps) assert.deepEqual(noticeStatus(table, stored), { state: "needed", updated: false, items: everything }, JSON.stringify(stored));
  }
  const rules = { dataConsentVersion: DATA_CONSENT_VERSION, dataConsentFingerprint: DATA_CONSENT_FINGERPRINT };
  for (const { version, fingerprint } of EARLY_CONSENT) {
    assert.equal(dataConsentGiven({ dataConsentVersion: version, dataConsentFingerprint: fingerprint }, rules), false, `${version} ${fingerprint}`);
  }
});

test("版本相同指纹不同、认不出的版本：确认失效，认不出同意过什么就按第一次给完整说明", () => {
  const cases: readonly [NoticeTable<string>, number, string][] = [
    [DATA_CONSENT_TABLE, DATA_CONSENT_VERSION, DATA_CONSENT_FINGERPRINT],
    [ACTIVATION_TABLE, ACTIVATION_VERSION, ACTIVATION_FINGERPRINT],
  ];
  for (const [table, version, fingerprint] of cases) {
    const everything = table.flatMap((row) => row.items);
    const expected = { state: "needed", updated: false, items: everything };
    assert.deepEqual(noticeStatus(table, { version, fingerprint: OLD_FINGERPRINT }), expected);
    assert.deepEqual(noticeStatus(table, { version, fingerprint: "" }), expected);
    assert.deepEqual(noticeStatus(table, { version }), expected);
    assert.deepEqual(noticeStatus(table, { version: version + 1, fingerprint }), expected);
  }
  assert.equal(noticeStatus(DATA_CONSENT_TABLE, { version: "1", fingerprint: DATA_CONSENT_FINGERPRINT }).state, "needed");
});
