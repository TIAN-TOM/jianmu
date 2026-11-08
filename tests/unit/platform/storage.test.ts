// chrome.storage 的封装。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionStorage, isQuotaError, readItem, restrictToTrustedContexts } from "../../../src/platform/storage.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

test("readItem 取出这一项的值，没有这一项时是 undefined", async () => {
  const area = memoryStorage({ 有: { a: 1 } });
  assert.deepEqual(await readItem(area, "有"), { a: 1 });
  assert.equal(await readItem(area, "没有"), undefined);
});

test("restrictToTrustedContexts 申请只给扩展页面和后台读", async () => {
  const requests: unknown[] = [];
  const area = {
    ...memoryStorage(),
    async setAccessLevel(options: unknown) {
      requests.push(options);
    },
  };

  await restrictToTrustedContexts(area);

  assert.deepEqual(requests, [{ accessLevel: "TRUSTED_CONTEXTS" }]);
});

test("restrictToTrustedContexts 在浏览器不支持或拒绝时抛错，不当作已经设好", async () => {
  await assert.rejects(restrictToTrustedContexts(memoryStorage()), /不能限制/);

  const refused = {
    ...memoryStorage(),
    async setAccessLevel() {
      throw new Error("这个版本不支持");
    },
  };
  await assert.rejects(restrictToTrustedContexts(refused), /这个版本不支持/);
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

test("isQuotaError 认得两种写满的文案，别的错不算", () => {
  assert.equal(isQuotaError(new Error("Resource::kQuotaBytes quota exceeded")), true);
  assert.equal(isQuotaError(new Error("QUOTA_BYTES quota exceeded")), true);
  assert.equal(isQuotaError(new Error("IO error")), false);
  assert.equal(isQuotaError("quota exceeded"), false, "不是异常对象的不认");
});
