// Web Locks 的封装：用 Node 自带的 navigator.locks 跑，和浏览器是同一份规范。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocks } from "../../../src/platform/locks.ts";
import { deferred, nextTurn } from "../../helpers/deferred.ts";

const LOCK = "测试用的锁";

async function heldModes(): Promise<(string | undefined)[]> {
  const { held } = await navigator.locks.query();
  return (held ?? []).map((lock) => lock.mode);
}

test("独占：前一个做完，后一个才开始", async () => {
  const locks = createLocks();
  const release = deferred();
  const order: string[] = [];
  const first = locks.exclusive(LOCK, async () => {
    order.push("第一个开始");
    await release.promise;
    order.push("第一个结束");
  });
  const second = locks.exclusive(LOCK, () => {
    order.push("第二个开始");
  });

  await nextTurn();
  assert.deepEqual(order, ["第一个开始"], "第二个还在排队");

  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["第一个开始", "第一个结束", "第二个开始"]);
});

test("共享：同为共享的可以同时做", async () => {
  const locks = createLocks();
  const bothIn = deferred();
  let inside = 0;
  const reader = () =>
    locks.shared(LOCK, async () => {
      inside += 1;
      if (inside === 2) bothIn.resolve();
      await bothIn.promise;
    });

  await Promise.all([reader(), reader()]);
  assert.equal(inside, 2, "排队的话第一个永远等不到第二个");
});

test("共享和独占互相排队：写的时候读要等，读的时候写也要等", async () => {
  const locks = createLocks();
  const release = deferred();
  const order: string[] = [];
  const writing = locks.exclusive(LOCK, async () => {
    await release.promise;
    order.push("写完");
  });
  const reading = locks.shared(LOCK, async () => {
    order.push("读");
    assert.deepEqual(await heldModes(), ["shared"]);
  });
  const writingAgain = locks.exclusive(LOCK, () => {
    order.push("再写");
  });

  await nextTurn();
  assert.deepEqual(await heldModes(), ["exclusive"]);
  release.resolve();
  await Promise.all([writing, reading, writingAgain]);
  assert.deepEqual(order, ["写完", "读", "再写"], "按申请的先后拿到锁");
});

test("锁里的工作出错：错误原样抛出，锁放开，后面的照常做", async () => {
  const locks = createLocks();
  await assert.rejects(
    locks.exclusive(LOCK, async () => {
      throw new Error("写不进去");
    }),
    /写不进去/,
  );
  assert.equal(await locks.exclusive(LOCK, () => "照常"), "照常");
});

test("两个实例拿的是同一把锁：页面和后台各建各的也互相排队", async () => {
  const release = deferred();
  const order: string[] = [];
  const page = createLocks().exclusive(LOCK, async () => {
    await release.promise;
    order.push("页面");
  });
  const background = createLocks().exclusive(LOCK, () => {
    order.push("后台");
  });

  await nextTurn();
  assert.deepEqual(order, [], "后台还在排队");
  release.resolve();
  await Promise.all([page, background]);
  assert.deepEqual(order, ["页面", "后台"]);
});
