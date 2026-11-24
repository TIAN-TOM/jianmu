// 粗筛页的状态：别的页面正在跑一步时，打开这一页要接上那一步，而不只是开着端口；这一页刚读完列表时直接摆出第一步的确认，
// 重新打开时不弹；第二步没有可写的视频时说为什么；AI 服务没设置好时状态行带「打开设置」，打开时滚到 AI 服务那一节。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { createTriageState } from "../../../../src/pages/triage/state.ts";
import type { PortHandlers } from "../../../../src/pages/shared/api.ts";
import type { BatchIn, TriageSnapshot } from "../../../../src/shared/messages/batch.ts";

function fakeApi(snapshot: TriageSnapshot, replies: Readonly<Record<string, unknown>> = {}) {
  const posted: BatchIn[] = [];
  const sent: { type: string; req: unknown }[] = [];
  let handlers: PortHandlers<"batch"> | null = null;
  const api = {
    send: async (type: string, req: unknown) => {
      sent.push({ type, req });
      return type in replies ? replies[type] : { ok: true, value: snapshot };
    },
    connect(_name: "batch", next: PortHandlers<"batch">) {
      handlers = next;
      return { post: (message: BatchIn) => (posted.push(message), true), close() {}, isOpen: () => true };
    },
  };
  return { api, posted, sent, emit: (event: Parameters<PortHandlers<"batch">["onEvent"]>[0]) => handlers?.onEvent(event) };
}

const KEYS = [videoKey({ platform: "bilibili", videoId: "BV1Sample001" }), videoKey({ platform: "bilibili", videoId: "BV1Sample002" })];
const LISTED: TriageSnapshot = {
  list: { fetchedAt: 1, count: 2, items: KEYS.map((key) => ({ videoKey: key, title: "样例标题", pageCount: 1, available: true })) },
  official: {},
  verdicts: {},
  running: null,
};
const OFFICIAL = { status: "ok", summary: "样例官方总结" };

const deps = { videoUrl: () => "", videoBase: () => "", download() {} };

test("打开时别的页面正在取官方总结：发同一步的开始接上它，进度和收尾这一页都收得到", async () => {
  const fake = fakeApi({ list: { fetchedAt: 1, count: 0, items: [] }, official: {}, verdicts: {}, running: "official" });
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  assert.deepEqual(fake.posted, [{ type: "triage.start", step: "official" }]);
  fake.emit({ type: "triage.started", step: "official", total: 3, skipped: 0, joined: true });
  assert.equal(state.running.value, "official");
  assert.match(state.officialStatus.value?.text ?? "", /接上了另一页/);
  fake.emit({ type: "triage.done", step: "official", done: 3, total: 3 });
  assert.equal(state.running.value, null);
});

test("打开时没有在跑的一步：不连端口、不发消息", async () => {
  const fake = fakeApi({ list: null, official: {}, verdicts: {}, running: null });
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  assert.deepEqual(fake.posted, []);
});

test("这一页读完列表直接摆出第一步的确认，照样先写数量；读列表失败不弹", async () => {
  const fake = fakeApi({ list: null, official: {}, verdicts: {}, running: null });
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  state.readList();
  assert.deepEqual(fake.posted, [{ type: "triage.start", step: "list" }]);
  fake.emit({ type: "triage.started", step: "list", total: 0, skipped: 0, joined: false });
  fake.emit({ type: "triage.done", step: "list", done: 2, total: 2, state: LISTED });
  assert.equal(state.pending.value?.step, "official");
  assert.equal(state.pending.value?.lines[0], "要逐个请求 2 个视频的 B 站官方总结。");
  state.cancel();

  state.readList();
  fake.emit({ type: "triage.done", step: "list", done: 0, total: 0, failure: { code: "NEED_LOGIN" } });
  assert.equal(state.pending.value, null);
});

test("重新打开页面时本机已有列表不弹确认；接上别的页面读的列表读完也不弹", async () => {
  const fake = fakeApi(LISTED);
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  assert.equal(state.pending.value, null);

  const joining = fakeApi({ ...LISTED, list: null, running: "list" });
  const joined = createTriageState({ api: joining.api as never, ...deps });
  await joined.load();
  joining.emit({ type: "triage.started", step: "list", total: 0, skipped: 0, joined: true });
  joining.emit({ type: "triage.done", step: "list", done: 2, total: 2, state: LISTED });
  assert.equal(joined.pending.value, null);
});

test("第二步没有可写结论的视频时说为什么：还没取到官方总结、都已经写过；有可写的或正在写时不说", async () => {
  const noOfficial = createTriageState({ api: fakeApi(LISTED).api as never, ...deps });
  await noOfficial.load();
  assert.equal(noOfficial.verdictIdle.value, "no-official");

  const withOfficial = { ...LISTED, official: { [KEYS[0] as string]: OFFICIAL } } as TriageSnapshot;
  const ready = createTriageState({ api: fakeApi(withOfficial).api as never, ...deps });
  await ready.load();
  assert.equal(ready.verdictIdle.value, null);

  const written = { ...withOfficial, verdicts: { [KEYS[0] as string]: { summary: "样例结论" } } } as TriageSnapshot;
  const done = createTriageState({ api: fakeApi(written).api as never, ...deps });
  await done.load();
  assert.equal(done.verdictIdle.value, "all-written");

  const running = fakeApi({ ...written, running: "verdict" });
  const busy = createTriageState({ api: running.api as never, ...deps });
  await busy.load();
  assert.equal(busy.verdictIdle.value, null);
});

test("AI 服务没设置好时第二步不弹确认，状态行带「打开设置」；打开设置时带上 AI 服务那一节", async () => {
  const withOfficial = { ...LISTED, official: { [KEYS[0] as string]: OFFICIAL } } as TriageSnapshot;
  const fake = fakeApi(withOfficial, { "config.check": { ok: true, value: { ready: false } }, "options.open": { ok: true, value: {} } });
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  await state.askVerdicts();
  assert.equal(state.pending.value, null);
  assert.deepEqual(state.verdictStatus.value, { text: "还没设置好 AI 服务。", tone: "error", settings: true });
  assert.equal(await state.openSettings("ai-service"), true);
  assert.equal(await state.openSettings(), true);
  assert.deepEqual(fake.sent.filter(({ type }) => type === "options.open"), [
    { type: "options.open", req: { section: "ai-service" } },
    { type: "options.open", req: {} },
  ]);
});
