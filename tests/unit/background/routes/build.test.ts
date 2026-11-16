// 构建标识：侧边栏、设置页、粗筛页和卡片在确认启用之前也能问，回的就是这次构建的标识。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { BUILD_ID } from "../../../../src/shared/build-id.ts";
import { createFakeChrome, senders } from "../../../helpers/chrome.ts";

test("确认前侧边栏、设置页、粗筛页都能读到后台的构建标识，不读存储；卡片也能读", async () => {
  const fake = createFakeChrome();
  const app = createApp(fake.deps());
  for (const sender of [senders.panel(), senders.options(), senders.triage()]) {
    assert.deepEqual(await app.dispatch({ type: "build.id", req: {} }, sender), { ok: true, value: { build: BUILD_ID } });
  }
  assert.deepEqual(fake.calls.storageReads, []);
  // 卡片的请求都先过卡片开关，这一步要读设置。
  assert.deepEqual(await app.dispatch({ type: "build.id", req: {} }, senders.card()), { ok: true, value: { build: BUILD_ID } });
});

test("后台不认识的请求回 UNKNOWN_ROUTE，不当成页面没权限", async () => {
  const fake = createFakeChrome();
  const app = createApp(fake.deps());
  assert.deepEqual(await app.dispatch({ type: "future.route", req: {} }, senders.triage()), { ok: false, code: "UNKNOWN_ROUTE" });
});
