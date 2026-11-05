import assert from "node:assert/strict";
import { test } from "node:test";
import { createClearGuard, NO_CLEAR_GUARD } from "../../../src/core/clear-guard.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test("清除全部数据：两个代数都变；清除缓存：只有缓存代数变", async () => {
  const guard = createClearGuard();
  const before = guard.epoch();
  await guard.clear("cache", () => {});
  assert.equal(guard.clearedSince(before, "cache"), true);
  assert.equal(guard.clearedSince(before, "all"), false, "清除缓存不碰笔记、概览、问答");
  const middle = guard.epoch();
  await guard.clear("all", () => {});
  assert.equal(guard.clearedSince(middle, "cache"), true);
  assert.equal(guard.clearedSince(middle, "all"), true);
  assert.equal(guard.clearedSince(undefined), false, "没记代数的当作没清过");
});

test("已经在写的先写完，清除才动手；写的那一刻再查代数，清过就不写", async () => {
  const guard = createClearGuard();
  const order: string[] = [];
  const since = guard.epoch();
  const holding = deferred();
  const started = deferred();
  const writing = guard.track(async () => {
    if (guard.clearedSince(since)) return "skipped";
    started.resolve();
    await holding.promise;
    order.push("write");
    return "written";
  });
  await started.promise;
  const clearing = guard.clear("all", () => order.push("clear"));
  assert.deepEqual(order, [], "清除在等进行中的写入");
  holding.resolve();
  assert.equal(await writing, "written");
  await clearing;
  assert.deepEqual(order, ["write", "clear"]);

  // 清除之前开始、清除之后才轮到写的那一下：看到新代数，不写。
  assert.equal(
    await guard.track(() => (guard.clearedSince(since) ? "skipped" : "written")),
    "skipped",
  );
});

test("写入一进 track 就算登记：同步跟上的清除也要等它写完", async () => {
  const guard = createClearGuard();
  const order: string[] = [];
  const holding = deferred();
  const writing = guard.track(async () => {
    await holding.promise;
    order.push("write");
  });
  const clearing = guard.clear("all", () => {
    order.push("clear");
  });
  await nextTurn();
  assert.deepEqual(order, [], "清除在等同一个同步段里登记的写入");
  holding.resolve();
  await Promise.all([writing, clearing]);
  assert.deepEqual(order, ["write", "clear"]);
});

test("清除进行中才进来的写入，等清除做完再写，不会被清掉", async () => {
  const guard = createClearGuard();
  const order: string[] = [];
  const store = new Set(["old"]);
  const holding = deferred();
  const clearing = guard.clear("all", async () => {
    await holding.promise;
    store.clear();
    order.push("clear");
  });
  const since = guard.epoch();
  const writing = guard.track(() => {
    if (guard.clearedSince(since)) return;
    store.add("new");
    order.push("write");
  });
  assert.deepEqual(order, []);
  holding.resolve();
  await Promise.all([clearing, writing]);
  assert.deepEqual(order, ["clear", "write"]);
  assert.deepEqual([...store], ["new"]);
});

test("写入出错不挡住清除，错误照常交回调用方", async () => {
  const guard = createClearGuard();
  const failing = guard.track(async () => {
    throw new Error("磁盘满了");
  });
  const clearing = guard.clear("all", () => "cleared");
  await assert.rejects(failing, /磁盘满了/);
  assert.equal(await clearing, "cleared");
});

test("清除出错后闸门重开：错误交回调用方，排队的和之后的写入都照常完成", async () => {
  const guard = createClearGuard();
  const holding = deferred();
  const clearing = guard.clear("all", async () => {
    await holding.promise;
    throw new Error("清除失败");
  });
  const queued = guard.track(() => "queued");
  holding.resolve();
  await assert.rejects(clearing, /清除失败/);
  const later = guard.track(() => "later");
  // 闸门没重开时写入永远等不到，和下一轮事件循环比快慢，让测试报失败而不是卡住。
  assert.deepEqual(await Promise.race([Promise.all([queued, later]), nextTurn()]), [
    "queued",
    "later",
  ]);
});

test("两次清除排队做，第二次等第一次做完", async () => {
  const guard = createClearGuard();
  const order: string[] = [];
  const holding = deferred();
  const first = guard.clear("cache", async () => {
    await holding.promise;
    order.push("first");
  });
  const second = guard.clear("all", () => order.push("second"));
  assert.deepEqual(order, []);
  holding.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("没接闸门时：从不算清过，写入照常执行", async () => {
  assert.equal(NO_CLEAR_GUARD.clearedSince(NO_CLEAR_GUARD.epoch()), false);
  assert.equal(await NO_CLEAR_GUARD.track(() => 1), 1);
});

test("没接闸门时：清除照常执行，结果交回调用方", async () => {
  assert.equal(await NO_CLEAR_GUARD.clear("all", () => 1), 1);
});
