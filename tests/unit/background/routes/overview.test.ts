// 概览的三条路由：开始生成只认登记过的任务，卡片只认登记时换到的一次性令牌、不能重新生成；补失败块和读概览只收形状对的请求；
// 读到的只有生效中的那份，重新生成写到一半的草稿不给页面。走真实的后台分发，模型服务和站点读取是替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { PROTOCOLS } from "../../../../src/core/ai/provider/index.ts";
import type { OverviewRecord } from "../../../../src/core/notes/records.ts";
import { createObjectStoreDriver } from "../../../../src/platform/idb.ts";
import { createFakeChrome, senders } from "../../../helpers/chrome.ts";
import { chatReply, keyedStorage, modelService } from "../../../helpers/fake-model-service.ts";
import { fakeSiteService } from "../../../helpers/fake-site-service.ts";
import { KEY, OTHER_REF } from "../../../helpers/transcript-service.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const GATEWAY = { presetId: "custom", protocol: PROTOCOLS.OPENAI, aiBaseUrl: "https://gateway.example.com/v1", aiModel: "test-model" };
const ORIGIN = "https://gateway.example.com/";
const PROMPT = ["## 系统提示词", "```", "系统", "```", "## 用户提示词", "```", "用户 {minTimestampSeconds}", "```", ""].join("\n");
const CHAPTER = chatReply(JSON.stringify({ chapters: [{ title: "开场", timestampSeconds: 0, summary: "摘要" }], keyQuotes: [] }));

function appOn() {
  const ai = modelService(() => CHAPTER);
  const fake = createFakeChrome({
    ...keyedStorage(GATEWAY, ORIGIN),
    grantedOrigins: [ORIGIN],
    fetch: ai.fetch,
    prompts: { "analysis.md": PROMPT, "verdict.md": PROMPT },
    site: fakeSiteService().service,
  });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const ask = (type: string, req: unknown, sender = senders.panel()) => app.dispatch({ type, req }, sender) as Promise<{ ok: boolean; code?: string; value?: never }>;
  async function register(sender = senders.panel(), video = KEY): Promise<{ readonly id: string; readonly token?: string }> {
    const started = (await app.dispatch({ type: "task.start", req: { kind: "overview", video } }, sender)) as { ok: true; value: { task: { id: string }; token?: string } };
    assert.ok(started.ok, JSON.stringify(started));
    return { id: started.value.task.id, ...(started.value.token ? { token: started.value.token } : {}) };
  }
  return { ai, fake, app, ask, register };
}

test("开始生成的请求形状：任务号和令牌恰好带一个，多带字段、视频键解析不出的都不处理", async () => {
  const { ask, ai } = appOn();
  for (const req of [
    { video: KEY },
    { video: KEY, taskId: "t", token: "k" },
    { video: KEY, taskId: "" },
    { video: KEY, taskId: "t", extra: 1 },
    { video: KEY, taskId: "t", fresh: "yes" },
    { video: "不是视频键", taskId: "t" },
    null,
  ]) {
    assert.equal((await ask("overview.start", req)).code, "INVALID_REQUEST", JSON.stringify(req));
  }
  assert.equal((await ask("overview.retryFailed", { video: KEY })).code, "INVALID_REQUEST");
  assert.equal((await ask("overview.get", { video: KEY, extra: 1 })).code, "INVALID_REQUEST");
  assert.equal(ai.sent.length, 0);
});

test("侧边栏凭登记的任务号开始生成；别的视频登记的任务、没登记的任务号都不认", async () => {
  const { ask, register, ai } = appOn();
  const other = await register(senders.panel(), videoKey(OTHER_REF));
  assert.equal((await ask("overview.start", { video: KEY, taskId: other.id })).code, "TASK_NOT_FOUND");
  assert.equal((await ask("overview.start", { video: KEY, taskId: "没登记" })).code, "TASK_NOT_FOUND");
  assert.equal((await ask("overview.start", { video: KEY, token: "随便" })).code, "FORBIDDEN", "侧边栏不用令牌");
  assert.equal(ai.sent.length, 0);

  const mine = await register();
  const result = await ask("overview.start", { video: KEY, taskId: mine.id });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(ai.posts().length > 0);
});

test("卡片只认登记时换到的一次性令牌：用过一次就作废，不收任务号，不能重新生成", async () => {
  const { ask, register } = appOn();
  const card = senders.card();
  const first = await register(card);
  assert.ok(first.token);
  assert.equal((await ask("overview.start", { video: KEY, taskId: first.id }, card)).code, "FORBIDDEN");
  assert.equal((await ask("overview.start", { video: KEY, token: first.token, fresh: true }, card)).code, "FORBIDDEN");
  const done = await ask("overview.start", { video: KEY, token: first.token }, card);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal((await ask("overview.start", { video: KEY, token: first.token }, card)).code, "TASK_NOT_FOUND", "令牌用一次就作废");
  assert.equal((await ask("overview.get", { video: KEY }, card)).code, "FORBIDDEN", "卡片不读这条，它的概览经轻量读取带回");
});

test("读概览只给生效中的那份：重新生成写到一半的草稿和各部分的来历都不给页面", async () => {
  const { app, fake } = appOn();
  const draft: OverviewRecord = {
    schemaVersion: 1,
    videoKey: KEY,
    snapshot: { title: "测试视频", author: "UP 主" },
    analysis: { chapters: [{ title: "生效的", timestampSeconds: 0 }], keyQuotes: [] },
    draft: { analysis: { chapters: [{ title: "草稿里的", timestampSeconds: 0 }], keyQuotes: [] }, chapters: { derived: { basis: { source: "legacy-unknown" } }, taskCreatedAt: 1 } },
    parts: { chapters: { derived: { basis: { source: "legacy-unknown" } }, taskCreatedAt: 1 } },
    updatedAt: 1,
  };
  await createObjectStoreDriver<OverviewRecord>({ storeName: "overviews", indexedDB: fake.indexedDB }).write({ put: [draft] });
  const result = (await app.dispatch({ type: "overview.get", req: { video: KEY } }, senders.panel())) as { ok: true; value: unknown };
  assert.ok(result.ok);
  assert.deepEqual(result.value, { video: KEY, overview: { analysis: draft.analysis, analysisFailures: [] } });
});
