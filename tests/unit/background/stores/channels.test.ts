// 频道偏好仓储：按频道键存取模式，读出来的行不信；写入经清除闸门，清除全部数据之前开始的写不写回。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createChannelStore, type ChannelRecord } from "../../../../src/background/stores/channels.ts";
import { createClearGuard, NO_CLEAR_GUARD } from "../../../../src/core/clear-guard.ts";
import { channelKey } from "../../../../src/core/video-ref.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

const CHANNEL = channelKey({ platform: "bilibili", channelId: "4242" });
const OTHER = channelKey({ platform: "youtube", channelId: "UC-sample" });

function harness(seed: readonly ChannelRecord[] = [], guard = NO_CLEAR_GUARD) {
  const driver = createMemoryDriver<ChannelRecord>("channels", seed);
  return { driver, store: createChannelStore({ driver, guard, now: () => 5000 }) };
}

test("记下频道的模式后按频道键读回；没记过的是 undefined，两站同号的频道互不相干", async () => {
  const { store, driver } = harness();
  assert.equal(await store.get(CHANNEL), undefined);
  assert.equal(await store.put(CHANNEL, "study"), true);
  assert.equal(await store.get(CHANNEL), "study");
  assert.equal(await store.get(OTHER), undefined);
  assert.deepEqual(await driver.getAll(), [{ channelKey: CHANNEL, mode: "study", updatedAt: 5000 }]);

  await store.put(CHANNEL, "skim");
  assert.equal(await store.get(CHANNEL), "skim", "后选的覆盖先选的");
});

test("库里的行不信：模式认不出、键对不上的当作没记过", async () => {
  const { store } = harness([
    { channelKey: CHANNEL, mode: "english" as never, updatedAt: 1 },
    { channelKey: OTHER, mode: null as never, updatedAt: 1 },
  ]);
  assert.equal(await store.get(CHANNEL), undefined);
  assert.equal(await store.get(OTHER), undefined);
});

test("清掉全部频道偏好", async () => {
  const { store, driver } = harness([
    { channelKey: CHANNEL, mode: "study", updatedAt: 1 },
    { channelKey: OTHER, mode: "skim", updatedAt: 1 },
  ]);
  assert.equal(await store.clear(), true);
  assert.deepEqual(await driver.getAll(), []);
});

test("清除全部数据之前开始的写入不写回；清除缓存不挡频道偏好", async () => {
  const guard = createClearGuard();
  const { store, driver } = harness([], guard);

  const before = guard.epoch();
  await guard.clear("cache", () => undefined);
  assert.equal(await store.put(CHANNEL, "study", { since: before }), true, "清除缓存不动频道偏好");

  const started = guard.epoch();
  await guard.clear("all", () => driver.clear());
  assert.equal(await store.put(OTHER, "study", { since: started }), false);
  assert.equal(await store.clear({ since: started }), false);
  assert.deepEqual(await driver.getAll(), []);
});
