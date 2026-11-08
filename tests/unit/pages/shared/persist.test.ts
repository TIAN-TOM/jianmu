// 持久化存储的申请：每个页面只申请一次，回浏览器同不同意；浏览器没有这个方法、不同意或者出错，都照常运行。
import assert from "node:assert/strict";
import { test } from "node:test";
import { requestPersistence } from "../../../../src/pages/shared/persist.ts";

test("每个页面只申请一次，回浏览器同不同意", async () => {
  let calls = 0;
  const storage = {
    persist: async () => {
      calls += 1;
      return true;
    },
  };
  assert.equal(await requestPersistence(storage), true);
  assert.equal(await requestPersistence(storage), true);
  assert.equal(calls, 1, "再调回第一次的结果，不再申请");
});

test("浏览器没有这个方法、不同意、出错或者回了怪东西：回 false，不抛错", async () => {
  assert.equal(await requestPersistence(undefined), false);
  assert.equal(await requestPersistence({}), false);
  assert.equal(await requestPersistence({ persist: async () => false }), false);
  assert.equal(await requestPersistence({ persist: () => Promise.reject(new Error("不行")) }), false);
  assert.equal(
    await requestPersistence({
      persist: () => {
        throw new Error("同步就抛了");
      },
    }),
    false,
  );
  assert.equal(await requestPersistence({ persist: async () => "true" as unknown as boolean }), false);
});

test("没有页面环境时（Node 里没有 navigator.storage）照常运行", async () => {
  assert.equal(await requestPersistence(), false);
});
