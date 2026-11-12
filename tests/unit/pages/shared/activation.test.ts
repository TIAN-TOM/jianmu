// 页面的启用状态：问一次后台；确认启用写入中不重复发、失败留在这一页；启用失效（清除全部、说明升版）马上按没启用处理再重问；
// 途中来的广播不被旧回答盖回去；停止以后不再变。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVATION_TABLE, noticeStatus } from "../../../../src/core/consent.ts";
import { createActivation } from "../../../../src/pages/shared/activation.ts";
import { createPageApi } from "../../../../src/pages/shared/api.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { fakeRuntime } from "../../../helpers/fake-runtime.ts";
import { until } from "../../../helpers/wait-until.ts";

const NEEDED = noticeStatus(ACTIVATION_TABLE, {});

function setup() {
  const fake = fakeRuntime();
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  const activation = createActivation({ api });
  return { fake, api, activation };
}

test("启用状态：没问到之前不算启用；确认过的是已启用，没确认过的给出这次要看的说明，问失败也不算启用", async () => {
  const { fake, activation } = setup();
  assert.deepEqual(activation.view.value, { state: "loading" });
  assert.equal(activation.enabled.value, false);

  fake.reply("activation.get", { value: { ok: true, value: NEEDED } });
  await activation.load();
  assert.equal(NEEDED.state, "needed");
  assert.deepEqual(activation.view.value, NEEDED);
  assert.equal(activation.enabled.value, false);

  fake.reply("activation.get", { value: { ok: true, value: { state: "current" } } });
  await activation.load();
  assert.deepEqual(activation.view.value, { state: "current" });
  assert.equal(activation.enabled.value, true);

  fake.reply("activation.get", () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  });
  await activation.load();
  assert.deepEqual(activation.view.value, { state: "failed", failure: { ok: false, code: "BACKGROUND_UNREACHABLE" } });
  assert.equal(activation.enabled.value, false);
});

test("确认启用：写入中再点不重复发；成功后已启用，记下补注入没补上的标签页", async () => {
  const { fake, activation } = setup();
  fake.reply("activation.get", { value: { ok: true, value: NEEDED } });
  await activation.load();
  const gate = deferred();
  fake.reply("activation.confirm", async () => {
    await gate.promise;
    return { ok: true, value: { state: "current", unreachableTabs: [12] } };
  });

  const first = activation.confirm();
  assert.equal(activation.phase.value, "saving");
  const second = activation.confirm();
  assert.equal(fake.attempts("activation.confirm"), 1, "写入中再点不再发");
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(fake.attempts("activation.confirm"), 1);

  assert.equal(activation.phase.value, "idle");
  assert.equal(activation.enabled.value, true);
  assert.deepEqual(activation.unreachableTabs.value, [12]);
  assert.equal(activation.confirmFailure.value, null);
});

test("确认启用写入失败：留在说明这一页，写原因；再点能重试", async () => {
  const { fake, activation } = setup();
  fake.reply("activation.get", { value: { ok: true, value: NEEDED } });
  await activation.load();
  fake.reply("activation.confirm", { value: { ok: false, code: "STORAGE_FULL" } });

  await activation.confirm();
  assert.equal(activation.phase.value, "failed");
  assert.deepEqual(activation.confirmFailure.value, { ok: false, code: "STORAGE_FULL" });
  assert.deepEqual(activation.view.value, NEEDED, "说明还在");
  assert.equal(activation.enabled.value, false);

  fake.reply("activation.confirm", { value: { ok: true, value: { state: "current", unreachableTabs: [] } } });
  await activation.confirm();
  assert.equal(fake.attempts("activation.confirm"), 2);
  assert.equal(activation.phase.value, "idle");
  assert.equal(activation.confirmFailure.value, null);
  assert.equal(activation.enabled.value, true);
});

test("启用失效（清除全部数据、说明升版）：马上按没启用处理，再问后台这次要看的说明；只清缓存不动；收到确认立刻算启用", async () => {
  const { fake, activation } = setup();
  fake.reply("activation.get", { value: { ok: true, value: { state: "current" } } });
  await activation.load();
  assert.equal(activation.enabled.value, true);

  const answer = deferred();
  fake.reply("activation.get", async () => {
    await answer.promise;
    return { ok: true, value: NEEDED };
  });
  fake.broadcast({ type: "activation.changed", confirmed: false });
  assert.equal(activation.enabled.value, false, "广播一到就不再算启用，不等重问回来");
  assert.deepEqual(activation.view.value, { state: "loading" });
  answer.resolve();
  assert.ok(await until(() => activation.view.value.state === "needed"));
  assert.equal(fake.attempts("activation.get"), 2);

  fake.broadcast({ type: "activation.changed", confirmed: true });
  assert.equal(activation.enabled.value, true);

  fake.broadcast({ type: "data.cleared", scope: "cache" });
  await nextTurn();
  assert.equal(activation.enabled.value, true, "只清缓存不影响启用");
  assert.equal(fake.attempts("activation.get"), 2);

  fake.broadcast({ type: "data.cleared", scope: "all" });
  assert.equal(activation.enabled.value, false);
  assert.ok(await until(() => activation.view.value.state === "needed"));
  assert.equal(fake.attempts("activation.get"), 3);
});

test("问的途中来了启用广播：以广播为准，旧的回答不盖回去", async () => {
  const { fake, activation } = setup();
  const answer = deferred();
  fake.reply("activation.get", async () => {
    await answer.promise;
    return { ok: true, value: NEEDED };
  });
  const loading = activation.load();
  fake.broadcast({ type: "activation.changed", confirmed: true });
  answer.resolve();
  await loading;
  assert.deepEqual(activation.view.value, { state: "current" });
});

test("停止以后广播和迟到的回答都不再改状态", async () => {
  const { fake, activation } = setup();
  const answer = deferred();
  fake.reply("activation.get", async () => {
    await answer.promise;
    return { ok: true, value: { state: "current" } };
  });
  const loading = activation.load();
  activation.stop();
  answer.resolve();
  await loading;
  fake.broadcast({ type: "activation.changed", confirmed: true });
  fake.broadcast({ type: "data.cleared", scope: "all" });
  await nextTurn();
  assert.deepEqual(activation.view.value, { state: "loading" });
  assert.equal(fake.attempts("activation.get"), 1);
  await activation.confirm();
  assert.equal(fake.attempts("activation.confirm"), 0);
});

test("确认的回答还在路上时启用失效：迟到的回答不把页面改回已启用，重新问后台", async () => {
  const { fake, activation } = setup();
  fake.reply("activation.get", { value: { ok: true, value: NEEDED } });
  await activation.load();
  const gate = deferred();
  fake.reply("activation.confirm", async () => {
    await gate.promise;
    return { ok: true, value: { state: "current", unreachableTabs: [12] } };
  });
  const confirming = activation.confirm();
  fake.broadcast({ type: "data.cleared", scope: "all" });
  assert.ok(await until(() => activation.view.value.state === "needed"));
  const asked = fake.attempts("activation.get");

  gate.resolve();
  await confirming;
  assert.equal(activation.enabled.value, false, "失效之后才到的确认回答不算数");
  assert.deepEqual(activation.view.value, NEEDED);
  assert.equal(fake.attempts("activation.get"), asked + 1, "重新问了一次后台");
  assert.deepEqual(activation.unreachableTabs.value, []);
  assert.equal(activation.phase.value, "idle");
});

test("确认的回答还在路上时启用失效过，但后台最后是已启用：重问以后算启用，记下没补上的标签页", async () => {
  const { fake, activation } = setup();
  fake.reply("activation.get", { value: { ok: true, value: NEEDED } });
  await activation.load();
  const gate = deferred();
  fake.reply("activation.confirm", async () => {
    await gate.promise;
    return { ok: true, value: { state: "current", unreachableTabs: [7] } };
  });
  const confirming = activation.confirm();
  fake.broadcast({ type: "activation.changed", confirmed: false });
  assert.ok(await until(() => activation.view.value.state === "needed"));

  fake.reply("activation.get", { value: { ok: true, value: { state: "current" } } });
  gate.resolve();
  await confirming;
  assert.equal(activation.enabled.value, true);
  assert.deepEqual(activation.unreachableTabs.value, [7]);
});
