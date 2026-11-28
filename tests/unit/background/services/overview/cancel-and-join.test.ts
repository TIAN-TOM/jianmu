// 概览任务的取消和接上：取消时在途请求在本机中止，本窗口全部生成发起的不占键，马上能重新生成，旧任务存下的部分盖不掉新任务的结果；
// 来源是自动生成的占键只占到存完已完成的块。生成、重新生成、补失败块是同一个等价任务：后到的接上在跑的那个，按在跑的那种方式走。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskOrigin } from "../../../../../src/core/tasks.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { ANALYSIS_GEN, chapterReply, hang, overviewHarness, titles, value, VERDICT_GEN, verdictReply, VIDEO, type Ask } from "../../../../helpers/overview-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

/** 和本窗口全部生成（window.ts）、打开就出结论、侧边栏登记的一样，只是来源不同。 */
const overviewSpec = (origin: TaskOrigin) => ({ kind: "overview" as const, origin, video: VIDEO, gen: ANALYSIS_GEN, stages: [VERDICT_GEN], followsPage: false });

/**
 * 第一块已经完成、第二块挂在模型那里时取消，旧任务收尾要先存下第一块：把这次写挂在门口，让旧任务停在「取消了、还没收尾」。
 * 这时侧边栏马上再点一次生成，看登记得上登记不上。
 */
async function cancelWhileUnwinding(origin: TaskOrigin) {
  const write = deferred();
  let holding = false;
  const h = overviewHarness({
    respond: (ask) => {
      if (ask.isVerdict) return undefined;
      return ask.user.includes("FAIL标记") ? hang(ask.request.signal) : undefined;
    },
    wrapStore: (inner) => {
      const updateRecord: typeof inner.updateRecord = async (key, plan, options) => {
        if (holding) await write.promise;
        return inner.updateRecord(key, plan, options);
      };
      return { find: inner.find, updateRecord };
    },
  });
  const registered = await h.tasks.register(overviewSpec(origin), {});
  assert.ok("task" in registered);
  const first = registered.task.id;
  const result = h.service.generate(first, VIDEO, { fresh: false });
  assert.ok(await until(() => h.previews().length === 1), "第一块完成，第二块还挂着");
  const inFlight = h.chunkAsks();
  holding = true;
  h.tasks.cancel(first);
  const again = await h.tasks.register(overviewSpec("user"), {});
  const unwinding = h.tasks.list().find((task) => task.id === first);
  write.resolve();
  return { h, first, result, inFlight, again, unwinding };
}

test("本窗口全部生成的概览取消后、还没收尾就让出互斥键，同一视频马上能再登记；在途请求在本机中止", async () => {
  const batch = await cancelWhileUnwinding("batch");
  assert.equal(batch.unwinding?.state, "canceled", "旧任务取消了、还在存已完成的那块");
  assert.ok("task" in batch.again && !batch.again.joined && batch.again.task.id !== batch.first, "不等旧任务收尾就登记上新任务");
  assert.ok(batch.inFlight.every((ask) => ask.request.signal?.aborted === true), "已经发出去的请求随取消中止");
  assert.equal(value(await batch.result).canceled, true);
});

test("打开就出结论的概览取消后占着键，只占到存完已完成的块；在途请求同样中止", async () => {
  const auto = await cancelWhileUnwinding("auto");
  assert.equal(auto.unwinding?.state, "canceled");
  assert.ok("conflict" in auto.again, "取消后、收尾之前仍占着键");
  assert.ok(auto.inFlight.every((ask) => ask.request.signal?.aborted === true));
  await auto.result;
  assert.ok("task" in (await auto.h.tasks.register(overviewSpec("user"), {})), "收尾以后就让键");
});

test("本窗口全部生成的概览停下后马上重新生成：旧任务存下的半份盖不掉新任务的结果，旧的请求也不会再回来", async () => {
  const slow = deferred();
  const h = overviewHarness();
  let round: "old" | "new" = "old";
  h.setRespond(async (ask: Ask) => {
    if (ask.isVerdict) return verdictReply();
    const seconds = Number(/minTimestampSeconds=(\d+)/.exec(ask.user)?.[1] ?? 0);
    if (round === "old" && seconds > 0) {
      await Promise.race([slow.promise, hang(ask.request.signal)]);
      return chapterReply(`旧@${seconds}`, seconds);
    }
    return chapterReply(`${round === "old" ? "旧" : "新"}@${seconds}`, seconds);
  });
  const registered = await h.tasks.register(overviewSpec("batch"), {});
  assert.ok("task" in registered);
  const oldResult = h.service.generate(registered.task.id, VIDEO, { fresh: false });
  assert.ok(await until(() => h.previews().length === 1), "第一块完成，第二块还挂着");
  const oldAsks = h.chunkAsks();

  h.timers.advance(1000);
  h.tasks.cancel(registered.task.id);
  round = "new";
  const again = await h.tasks.register(overviewSpec("user"), {});
  assert.ok("task" in again && !again.joined);
  const newResult = h.service.generate(again.task.id, VIDEO, { fresh: true });
  slow.resolve();

  assert.equal(value(await oldResult).canceled, true, "旧任务按停止收尾，存下已完成的那块");
  value(await newResult);
  assert.ok(oldAsks.every((ask) => ask.request.signal?.aborted === true), "旧任务挂着的那块被中止了");
  assert.deepEqual(titles(await h.record()), ["新@0", "新@150"], "生效的是新任务的章节");
  assert.equal(h.chunkAsks().length, 4, "旧任务两块、新任务两块，没有重发");
});

/** 一份带一个失败块的概览：第二块失败。 */
async function withFailedChunk() {
  const h = overviewHarness();
  h.setFailMode("marker");
  value(await h.generate().result);
  h.setFailMode(null);
  assert.equal((await h.record())?.analysisFailures?.length, 1);
  return h;
}

test("补失败块在跑时再登记重新生成：接上补块那个任务，按任务号开始也拿到补块的结果，不另外重新生成", async () => {
  const h = await withFailedChunk();
  const gate = deferred();
  h.setRespond(async (ask) => (ask.isVerdict ? verdictReply() : (await gate.promise, undefined)));
  const before = h.chunkAsks().length;
  const retryId = await h.register();
  const retrying = h.service.retryFailed(retryId, VIDEO);
  assert.ok(await until(() => h.chunkAsks().length === before + 1), "补块只发失败的那一块");

  const regenerateId = await h.register();
  assert.equal(regenerateId, retryId, "重新生成的登记接上了补块任务");
  const regenerating = h.service.generate(regenerateId, VIDEO, { fresh: true });
  gate.resolve();
  const [retried, regenerated] = [value(await retrying), value(await regenerating)];
  assert.equal(regenerated.recoveredChunks, 1, "拿到的是补块的结果");
  assert.deepEqual(regenerated, retried);
  assert.equal(h.chunkAsks().length - before, 1, "没有另发请求");
});

test("重新生成在跑时再登记补失败块：接上重新生成，补块不另跑", async () => {
  const h = await withFailedChunk();
  const gate = deferred();
  h.setRespond(async (ask) => (ask.isVerdict ? verdictReply() : (await gate.promise, undefined)));
  const before = h.chunkAsks().length;
  const regenerateId = await h.register();
  const regenerating = h.service.generate(regenerateId, VIDEO, { fresh: true });
  assert.ok(await until(() => h.chunkAsks().length === before + 2), "重新生成两块都发了");

  const retryId = await h.register();
  assert.equal(retryId, regenerateId, "补块的登记接上了重新生成");
  const retrying = h.service.retryFailed(retryId, VIDEO);
  gate.resolve();
  const retried = value(await retrying);
  assert.equal(retried.recoveredChunks, undefined, "拿到的是重新生成的结果");
  assert.deepEqual(retried, value(await regenerating));
  assert.equal(h.chunkAsks().length - before, 2, "补块没有另发请求");
});
