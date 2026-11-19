// 概览的三条路由：开始生成只认登记过的任务，卡片只认登记时换到的一次性令牌、不能重新生成；补失败块和读概览只收形状对的请求；
// 读到的只有生效中的那份，重新生成写到一半的草稿不给页面。走真实的后台分发，模型服务和站点读取是替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { overviewRoutes } from "../../../../src/background/routes/overview.ts";
import type { OverviewService } from "../../../../src/background/services/overview/index.ts";
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
    prompts: { "skim/chapters.md": PROMPT, "skim/verdict.md": PROMPT },
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

test("手动补失败块至少补上一块：打开就出结论从暂停里恢复；全部又失败的、本机已有的直接交回、中途停下的都不算", async () => {
  let resumed = 0;
  let value: { fromCache: boolean; recoveredChunks?: number; canceled?: true } = { fromCache: false, recoveredChunks: 1 };
  const overview = { retryFailed: async () => ({ ok: true, value }) } as unknown as OverviewService;
  const routes = overviewRoutes({ overview, cardLimits: { redeemToken: () => null }, auto: { resume: async () => void (resumed += 1) } });
  const retry = () => routes["overview.retryFailed"].handler({ taskId: "t", video: KEY }, {} as Parameters<(typeof routes)["overview.retryFailed"]["handler"]>[1]);

  assert.equal((await retry()).ok, true);
  assert.equal(resumed, 1);
  value = { fromCache: false, recoveredChunks: 0 };
  await retry();
  assert.equal(resumed, 1, "全部又失败了不恢复");
  value = { fromCache: true };
  await retry();
  value = { fromCache: false, recoveredChunks: 1, canceled: true };
  await retry();
  assert.equal(resumed, 1, "本机已有的、中途停下的不恢复");
});

test("手动生成或补失败块在结论那一步被停：不算成功，不解除打开就出结论的暂停", async () => {
  let resumed = 0;
  const stopped = { fromCache: false, recoveredChunks: 1, verdictCanceled: true };
  const overview = { generate: async () => ({ ok: true, value: stopped }), retryFailed: async () => ({ ok: true, value: stopped }) } as unknown as OverviewService;
  const routes = overviewRoutes({ overview, cardLimits: { redeemToken: () => null }, auto: { resume: async () => void (resumed += 1) } });
  const ctx = { sender: { kind: "panel" } } as unknown as Parameters<(typeof routes)["overview.start"]["handler"]>[1];
  await routes["overview.start"].handler({ video: KEY, taskId: "t" }, ctx);
  await routes["overview.retryFailed"].handler({ taskId: "t", video: KEY }, ctx);
  assert.equal(resumed, 0);
});

test("卡片在 YouTube 上点生成：交给生成一个准备步骤，经卡片所在的标签页读到字幕；页面这会儿不能点、读不成，按页面报的原因收尾", async () => {
  const TUBE = videoKey({ platform: "youtube", videoId: "tube-sample" });
  const reads: (readonly [string, number])[] = [];
  let read: unknown = { ok: true, value: {} };
  let prepared = 0;
  const overview = {
    async generate(_taskId: string, _video: string, options: { prepare?: () => Promise<unknown> }) {
      if (options.prepare) prepared += 1;
      const failure = options.prepare ? await options.prepare() : null;
      return failure ?? { ok: true, value: { fromCache: true } };
    },
  } as unknown as OverviewService;
  const routes = overviewRoutes({
    overview,
    cardLimits: { redeemToken: (token: string) => token },
    pageTranscript: {
      duration: async () => null,
      async read(ref, tabId) {
        reads.push([ref.videoId, tabId]);
        return read as never;
      },
    },
  });
  const ctx = { sender: { kind: "card", tabId: 9 } } as unknown as Parameters<(typeof routes)["overview.start"]["handler"]>[1];
  const start = async (video = TUBE) => (await routes["overview.start"].handler({ video, token: "t" }, ctx)) as { ok: boolean; code?: string; detail?: string };
  assert.equal((await start()).ok, true);
  assert.deepEqual(reads, [["tube-sample", 9]]);

  const cases = [
    [{ later: "ad" }, "PAGE_ACTION_NEEDED", "ad"],
    [{ later: "video-changed" }, "VIDEO_CHANGED", undefined],
    [{ later: "no-page" }, "UNAVAILABLE", "no-page"],
    [{ ok: false, code: "PAGE_ACTION_NEEDED", detail: "filtered" }, "PAGE_ACTION_NEEDED", "filtered"],
  ] as const;
  for (const [answer, code, detail] of cases) {
    read = answer;
    const result = await start();
    assert.deepEqual([result.ok, result.code, result.detail], [false, code, detail], JSON.stringify(answer));
  }

  const before = prepared;
  await start(KEY);
  assert.equal(prepared, before, "B 站视频不经页面读");
});
