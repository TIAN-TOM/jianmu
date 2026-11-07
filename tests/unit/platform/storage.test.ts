// chrome.storage 的封装。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionStorage, readItem } from "../../../src/platform/storage.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

test("readItem 取出这一项的值，没有这一项时是 undefined", async () => {
  const area = memoryStorage({ 有: { a: 1 } });
  assert.deepEqual(await readItem(area, "有"), { a: 1 });
  assert.equal(await readItem(area, "没有"), undefined);
});

test("extensionStorage 取的是浏览器的 local 和 session 两个存储区", (t) => {
  const local = memoryStorage();
  const session = memoryStorage();
  Object.defineProperty(globalThis, "chrome", { value: { storage: { local, session } }, configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });

  const storage = extensionStorage();
  assert.equal(storage.local, local);
  assert.equal(storage.session, session);
});
