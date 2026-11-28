// 认领任务的请求里取任务号：卡片只认一次性令牌、换不出回 TASK_NOT_FOUND，别的页面只认任务号、没带回 FORBIDDEN。
// 先单测共用函数，再把问答、结论、开始概览、补失败块四条路由各自收哪些形状、每格回什么、令牌兑换几次逐格钉住。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardLimits } from "../../../../src/background/limits.ts";
import { overviewRoutes } from "../../../../src/background/routes/overview.ts";
import { qaRoutes } from "../../../../src/background/routes/qa.ts";
import { claimTaskId, hasTaskIdOrToken } from "../../../../src/background/routes/task-claim.ts";
import { verdictRoutes } from "../../../../src/background/routes/verdict.ts";
import type { SenderCtx } from "../../../../src/background/senders.ts";
import { KEY } from "../../../helpers/transcript-service.ts";

const GOOD = "good-token";

/** 令牌替身：只有 GOOD 换得出任务号，记下每次兑换。 */
function redeemer() {
  const redeemed: string[] = [];
  const limits: Pick<CardLimits, "redeemToken" | "admitRegenerate"> = {
    redeemToken(token) {
      redeemed.push(token);
      return token === GOOD ? "from-token" : null;
    },
    admitRegenerate: () => true,
  };
  return { redeemed, limits };
}

const CARD: SenderCtx = { kind: "card", tabId: 7 };
const OTHERS: readonly SenderCtx[] = [{ kind: "panel" }, { kind: "page", page: "options" }, { kind: "page", page: "triage" }];

test("hasTaskIdOrToken：任务号和令牌恰好带一个，带着的是合格的编号", () => {
  assert.equal(hasTaskIdOrToken({ taskId: "t" }), true);
  assert.equal(hasTaskIdOrToken({ token: "k" }), true);
  assert.equal(hasTaskIdOrToken({ taskId: "t", token: "k" }), false, "两个都带");
  assert.equal(hasTaskIdOrToken({}), false, "都不带");
  assert.equal(hasTaskIdOrToken({ taskId: "" }), false);
  assert.equal(hasTaskIdOrToken({ token: "" }), false);
  assert.equal(hasTaskIdOrToken({ token: 1 }), false);
  assert.equal(hasTaskIdOrToken({ token: "x".repeat(101) }), false);
  assert.equal(hasTaskIdOrToken({ taskId: undefined, token: "k" }), false, "任务号这个键在就按任务号核对");
  assert.equal(hasTaskIdOrToken({ taskId: "t", token: undefined }), false, "令牌这个键在就算两个都带");
});

test("claimTaskId：卡片用令牌兑换一次，换得出给任务号，换不出回 TASK_NOT_FOUND", () => {
  const { redeemed, limits } = redeemer();
  assert.deepEqual(claimTaskId(CARD, { token: GOOD }, limits), { ok: true, taskId: "from-token" });
  assert.deepEqual(redeemed, [GOOD]);
  assert.deepEqual(claimTaskId(CARD, { token: "stale" }, limits), { ok: false, code: "TASK_NOT_FOUND" });
  assert.deepEqual(redeemed, [GOOD, "stale"], "换不出也只兑换一次");
});

test("claimTaskId：卡片带任务号或没带令牌回 FORBIDDEN，不碰令牌", () => {
  const { redeemed, limits } = redeemer();
  assert.deepEqual(claimTaskId(CARD, { taskId: "t" }, limits), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(claimTaskId(CARD, { taskId: "t", token: GOOD }, limits), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(claimTaskId(CARD, {}, limits), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(redeemed, []);
});

test("claimTaskId：别的页面只认任务号，没带回 FORBIDDEN，带了令牌也不兑换", () => {
  for (const sender of OTHERS) {
    const { redeemed, limits } = redeemer();
    assert.deepEqual(claimTaskId(sender, { taskId: "t" }, limits), { ok: true, taskId: "t" }, sender.kind);
    assert.deepEqual(claimTaskId(sender, { token: GOOD }, limits), { ok: false, code: "FORBIDDEN" }, sender.kind);
    assert.deepEqual(claimTaskId(sender, {}, limits), { ok: false, code: "FORBIDDEN" }, sender.kind);
    assert.deepEqual(redeemed, [], `${sender.kind} 不兑换令牌`);
  }
});

// 四条路由逐格对照：形状不对的在核对时就拒，不进处理、不兑换令牌；形状对的按发送方回。
const SHAPES = {
  token: { video: KEY, token: GOOD },
  staleToken: { video: KEY, token: "stale" },
  taskId: { video: KEY, taskId: "t1" },
  both: { video: KEY, taskId: "t1", token: GOOD },
  neither: { video: KEY },
  noVideo: { token: GOOD },
  badVideo: { video: "nope", token: GOOD },
  tokenExtra: { video: KEY, token: GOOD, extra: 1 },
  taskIdExtra: { video: KEY, taskId: "t1", extra: 1 },
  emptyToken: { video: KEY, token: "" },
  emptyTaskId: { video: KEY, taskId: "" },
  numberToken: { video: KEY, token: 5 },
  longToken: { video: KEY, token: "x".repeat(101) },
  undefinedTaskIdWithToken: { video: KEY, taskId: undefined, token: GOOD },
  undefinedTokenWithTaskId: { video: KEY, taskId: "t1", token: undefined },
  tokenFresh: { video: KEY, token: GOOD, fresh: true },
  taskIdFresh: { video: KEY, taskId: "t1", fresh: false },
  tokenFreshNotBoolean: { video: KEY, token: GOOD, fresh: "yes" },
  tokenTabId: { video: KEY, token: GOOD, tabId: 3 },
  taskIdTabId: { video: KEY, taskId: "t1", tabId: 3 },
  tokenBadTabId: { video: KEY, token: GOOD, tabId: -1 },
  array: [KEY],
  nothing: null,
} as const;
type Shape = keyof typeof SHAPES;

/** 每格的结果：「拒」是核对就不过；其余是处理的结果和令牌兑换的次数。 */
type Cell = "拒" | `ok:${string} 兑换${0 | 1}` | `${"FORBIDDEN" | "TASK_NOT_FOUND"} 兑换${0 | 1}`;
type Row = { readonly card: Cell; readonly other: Cell };

const BASE: Partial<Record<Shape, Row>> = {
  token: { card: "ok:from-token 兑换1", other: "FORBIDDEN 兑换0" },
  staleToken: { card: "TASK_NOT_FOUND 兑换1", other: "FORBIDDEN 兑换0" },
  taskId: { card: "FORBIDDEN 兑换0", other: "ok:t1 兑换0" },
};
// 开始概览另收 fresh 和 tabId；卡片点名标签页一律拒，不碰令牌。
const START: Partial<Record<Shape, Row>> = {
  ...BASE,
  tokenFresh: { card: "ok:from-token 兑换1", other: "FORBIDDEN 兑换0" },
  taskIdFresh: { card: "FORBIDDEN 兑换0", other: "ok:t1 兑换0" },
  tokenTabId: { card: "FORBIDDEN 兑换0", other: "FORBIDDEN 兑换0" },
  taskIdTabId: { card: "FORBIDDEN 兑换0", other: "ok:t1 兑换0" },
};
const TABLE: Record<"qa.ask" | "verdict.fromOfficial" | "overview.start" | "overview.retryFailed", Partial<Record<Shape, Row>>> = {
  "qa.ask": BASE,
  "verdict.fromOfficial": BASE,
  "overview.start": START,
  "overview.retryFailed": BASE,
};

type AnyRoute = { validate(req: unknown, ctx: SenderCtx): boolean; handler(req: unknown, ctx: { sender: SenderCtx }): Promise<{ ok: boolean; code?: string; value?: unknown }> };

function routesWith(limits: Pick<CardLimits, "redeemToken" | "admitRegenerate">): Record<keyof typeof TABLE, AnyRoute> {
  // 服务替身把认领到的任务号原样交回。
  const claimed = (taskId: string) => Promise.resolve({ ok: true, value: { taskId, fromCache: true, canceled: false } });
  const routes = {
    ...qaRoutes({ qa: { ask: claimed }, explain: {}, cardLimits: limits } as never),
    ...verdictRoutes({ verdict: { fromOfficial: claimed }, cardLimits: limits } as never),
    ...overviewRoutes({ overview: { generate: claimed, retryFailed: claimed }, cardLimits: limits } as never),
  };
  return routes as unknown as Record<keyof typeof TABLE, AnyRoute>;
}

async function cell(name: keyof typeof TABLE, sender: SenderCtx, req: unknown): Promise<Cell> {
  const { redeemed, limits } = redeemer();
  const route = routesWith(limits)[name];
  if (!route.validate(req, sender)) {
    assert.equal(redeemed.length, 0, "核对不过不兑换令牌");
    return "拒";
  }
  const result = await route.handler(req, { sender });
  const outcome = result.ok ? `ok:${(result.value as { taskId: string }).taskId}` : String(result.code);
  return `${outcome} 兑换${redeemed.length}` as Cell;
}

for (const [name, rows] of Object.entries(TABLE) as [keyof typeof TABLE, Partial<Record<Shape, Row>>][]) {
  test(`${name}：每种请求形状在卡片和别的页面上的结果`, async () => {
    for (const [shape, req] of Object.entries(SHAPES) as [Shape, unknown][]) {
      const row = rows[shape] ?? { card: "拒", other: "拒" };
      assert.equal(await cell(name, CARD, req), row.card, `${shape}，卡片`);
      for (const sender of OTHERS) assert.equal(await cell(name, sender, req), row.other, `${shape}，${sender.kind} ${sender.page ?? ""}`);
    }
  });
}
