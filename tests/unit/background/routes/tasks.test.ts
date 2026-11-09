// 任务的三条路由：登记的请求形状，卡片新起的生成每分钟最多 3 次、凭一次性令牌开始，接上在跑的不算一次。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { CARD_GENERATE_WINDOW_MS, createCardLimits, createRateLimit } from "../../../../src/background/limits.ts";
import type { TaskView } from "../../../../src/core/tasks.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, SAMPLE_VIDEO_ID, senders } from "../../../helpers/chrome.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID });
const tubeVideo = (index: number): VideoKey => videoKey({ platform: "youtube", videoId: `tube-${index}` });

type Started = { ok: true; value: { task: TaskView; joined: boolean; token?: string } } | { ok: false; code: string };

function appOn(local: Record<string, unknown> = { [SETTINGS_STORAGE_KEY]: CONFIRMED }) {
  const fake = createFakeChrome({ local, prompts: { "analysis.md": "概览提示词", "verdict.md": "结论提示词" } });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const start = (video: VideoKey, sender = senders.card()) =>
    app.dispatch({ type: "task.start", req: { kind: "overview", video } }, sender) as Promise<Started>;
  return { fake, app, start };
}

test("登记的请求按种类核对：概览和写结论只收种类和视频键，问答要带问题，解释要带选中的文字；别的种类、多带字段、视频键解析不出的都不登记", async () => {
  const { app } = appOn();
  for (const req of [
    { kind: "qa", video: VIDEO },
    { kind: "qa", video: VIDEO, question: 42 },
    { kind: "qa", video: VIDEO, question: "问题", extra: 1 },
    { kind: "qa", video: VIDEO, question: "问".repeat(20_001) },
    { kind: "explain", video: VIDEO },
    { kind: "explain", video: VIDEO, selection: "词", context: 1 },
    { kind: "overview", video: VIDEO, question: "问题" },
    { kind: "translate", video: VIDEO },
    { kind: "overview", video: VIDEO, extra: 1 },
    { kind: "overview", video: "" },
    { kind: "overview", video: "bilibili:not-a-video:p1" },
    { kind: "overview" },
    [],
    null,
  ]) {
    for (const sender of [senders.panel(), senders.card()]) {
      assert.deepEqual(await app.dispatch({ type: "task.start", req }, sender), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
    }
  }
  assert.deepEqual(await app.dispatch({ type: "task.list", req: {} }, senders.panel()), { ok: true, value: { tasks: [] } });
});

test("用官方总结写结论能登记，取定结论那项的配置；卡片登记不了这一种", async () => {
  const { app } = appOn();
  const panel = (await app.dispatch({ type: "task.start", req: { kind: "verdict", video: VIDEO } }, senders.panel())) as Started;
  assert.ok(panel.ok && panel.value.task.kind === "verdict" && !("token" in panel.value), JSON.stringify(panel));
  const again = (await app.dispatch({ type: "task.start", req: { kind: "verdict", video: VIDEO } }, senders.panel())) as Started;
  assert.ok(again.ok && again.value.joined && again.value.task.id === panel.value.task.id, "同一视频再点一次接上同一个任务");
  assert.deepEqual(await app.dispatch({ type: "task.start", req: { kind: "verdict", video: VIDEO } }, senders.card()), { ok: false, code: "FORBIDDEN" });
});

test("卡片发起的生成每分钟最多 3 次：同一视频已在生成不算一次，超出的说明原因；侧边栏不受限", async () => {
  const { fake, start } = appOn();
  for (const index of [1, 2, 3]) assert.equal((await start(tubeVideo(index))).ok, true, `第 ${index} 次`);
  assert.deepEqual(await start(tubeVideo(4)), { ok: false, code: "CARD_RATE_LIMITED" });

  const joined = await start(tubeVideo(1));
  assert.ok(joined.ok && joined.value.joined, "接上在跑的那个，不算一次，也不发令牌");
  assert.equal(joined.ok && "token" in joined.value, false);

  const panel = await start(tubeVideo(5), senders.panel());
  assert.ok(panel.ok && !panel.value.joined && !("token" in panel.value), "侧边栏不限、也不要令牌");

  fake.timers.advance(CARD_GENERATE_WINDOW_MS);
  assert.equal((await start(tubeVideo(6))).ok, true, "过了一分钟又能生成");
});

test("卡片新起的任务带一次性令牌，来源记成卡片；侧边栏起的记成用户发起", async () => {
  const { start } = appOn();
  const card = await start(VIDEO);
  assert.ok(card.ok && typeof card.value.token === "string" && card.value.token.length > 0);
  assert.equal(card.ok && card.value.task.origin, "card");
  const panel = await start(tubeVideo(1), senders.panel());
  assert.equal(panel.ok && panel.value.task.origin, "user");
});

test("设置里关掉卡片：卡片发来的登记一律拒绝、不登记任务；侧边栏照常", async () => {
  const { app, start } = appOn({ [SETTINGS_STORAGE_KEY]: { ...CONFIRMED, inPageCard: false } });
  assert.deepEqual(await start(VIDEO), { ok: false, code: "CARD_DISABLED" });
  assert.deepEqual(await app.dispatch({ type: "task.list", req: {} }, senders.panel()), { ok: true, value: { tasks: [] } });
  assert.equal((await start(VIDEO, senders.panel())).ok, true);
});

test("取消只收一个任务号：多带字段、空串、太长的都不处理；任务没了回任务已经结束", async () => {
  const { app } = appOn();
  for (const req of [{}, { taskId: "" }, { taskId: "x".repeat(101) }, { taskId: 1 }, { taskId: "a", extra: true }]) {
    assert.deepEqual(await app.dispatch({ type: "task.cancel", req }, senders.panel()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.deepEqual(await app.dispatch({ type: "task.cancel", req: { taskId: "missing" } }, senders.panel()), { ok: false, code: "TASK_NOT_FOUND" });
});

test("令牌用一次就作废，过了认领时限也作废，认不出的换不到任务", () => {
  let clock = 0;
  let next = 0;
  const limits = createCardLimits({ now: () => clock, newToken: () => `token-${(next += 1)}`, tokenTtlMs: 15_000 });
  const first = limits.issueToken("task-1");
  assert.equal(limits.redeemToken(first), "task-1");
  assert.equal(limits.redeemToken(first), null);

  const late = limits.issueToken("task-2");
  clock += 15_001;
  assert.equal(limits.redeemToken(late), null);
  assert.equal(limits.redeemToken("made-up"), null);
});

test("滑动窗口限频：窗口里放行满了就拒，最早那次滑出窗口后再放行一次", () => {
  let clock = 0;
  const take = createRateLimit({ limit: 3, windowMs: 60_000, now: () => clock });
  const at = (ms: number): boolean => {
    clock = ms;
    return take();
  };
  assert.deepEqual([at(0), at(10_000), at(20_000), at(30_000), at(59_999)], [true, true, true, false, false]);
  assert.deepEqual([at(60_000), at(60_000)], [true, false]);
});
