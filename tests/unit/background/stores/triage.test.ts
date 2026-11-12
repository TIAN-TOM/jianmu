// 粗筛的存储：读到的列表 30 天期限，过期按没读过；清除之后，之前开始的读取回来不写回、不把键重新建出来。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTriageStore } from "../../../../src/background/stores/triage.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import { STORAGE_KEY, TRIAGE_TTL_MS, withList, type TriageItem } from "../../../../src/core/triage/state.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

const items: readonly TriageItem[] = [{ videoKey: videoKey({ platform: "bilibili", videoId: "BV1Sample201", segment: 1 }), title: "一" }];

test("列表过了 30 天按没读过，官方总结一起不算", async () => {
  let clock = 1_000;
  const storage = memoryStorage();
  const store = createTriageStore({ storage, guard: createClearGuard(), now: () => clock });
  await store.update((current) => withList(current, { items, count: 1, fetchedAt: clock }), undefined);
  assert.equal((await store.read()).list?.items.length, 1);
  clock += TRIAGE_TTL_MS - 1;
  assert.equal((await store.read()).list?.items.length, 1);
  clock += 1;
  assert.equal((await store.read()).list, null);
});

test("清除缓存以后，之前开始的写入不写回，也不把键建出来", async () => {
  const storage = memoryStorage();
  const guard = createClearGuard();
  const store = createTriageStore({ storage, guard, now: () => 1 });
  const since = guard.epoch();
  await guard.clear("cache", async () => {});
  const written = await store.update((current) => withList(current, { items, count: 1, fetchedAt: 1 }), since);
  assert.equal(written, null);
  assert.equal(STORAGE_KEY in storage.data, false);
});
