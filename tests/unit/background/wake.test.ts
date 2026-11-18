// 醒来钩子：每次醒来只限制一次存储；每个事件先跑一遍每事件的检查，检查出错只记一条，不挡事件。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWake } from "../../../src/background/wake.ts";

test("每个事件先跑每事件的检查再处理；存储只在醒来后限制一次；检查出错不挡事件", async () => {
  const order: string[] = [];
  const warned: unknown[][] = [];
  let restricts = 0;
  let failing = false;
  const wake = createWake(
    async () => void (restricts += 1),
    { warn: (...args: unknown[]) => void warned.push(args), error: () => assert.fail() },
    () => {
      order.push("check");
      if (failing) throw new Error("看不了文件");
    },
  );
  const listener = wake((value: string) => (order.push(value), value.length));
  assert.equal(listener("a"), 1);
  await Promise.resolve();
  assert.equal(listener("bb"), 2);
  failing = true;
  assert.equal(listener("ccc"), 3);
  assert.deepEqual(order, ["check", "a", "check", "bb", "check", "ccc"]);
  assert.equal(restricts, 1);
  assert.equal(warned.length, 1);
});
