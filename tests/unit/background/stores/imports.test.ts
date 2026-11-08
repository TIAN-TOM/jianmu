// 导入字幕仓储：一个视频一份，换的时候读出原来那份；读出来的行不信；写入经清除闸门，清除缓存不挡，清除全部数据之前开始的不写。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createImportStore, type ImportRecord } from "../../../../src/background/stores/imports.ts";
import { createClearGuard, NO_CLEAR_GUARD } from "../../../../src/core/clear-guard.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { SAMPLE_ID, sampleInfo } from "../../../helpers/fake-site-service.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

const REF = { platform: "bilibili", videoId: SAMPLE_ID, segment: 1 } as const;
const VIDEO = videoKey(REF);
const OTHER = videoKey({ ...REF, segment: 2 });

const record = (fileName: string, video = VIDEO): ImportRecord => ({
  videoKey: video,
  fileName,
  format: "srt",
  cues: [{ start: 0, duration: 2, text: "第一句" }],
  importedAt: 1,
});

function harness(seed: readonly ImportRecord[] = [], guard = NO_CLEAR_GUARD) {
  const driver = createMemoryDriver<ImportRecord>("imports", seed);
  return { driver, store: createImportStore({ driver, guard }) };
}

test("一个视频存一份，后导入的换掉先导入的；换的时候读出原来那份，撤回时改回去", async () => {
  const { store, driver } = harness();
  assert.equal(await store.get(VIDEO), null);
  assert.deepEqual(await store.replace(VIDEO, record("甲.srt")), { previous: null });
  assert.deepEqual(await store.replace(VIDEO, record("乙.srt")), { previous: record("甲.srt") });
  assert.equal((await store.get(VIDEO))?.fileName, "乙.srt");
  assert.equal(await store.get(OTHER), null, "别的分 P 不相干");

  assert.equal(await store.restore(VIDEO, record("甲.srt")), true);
  assert.equal((await store.get(VIDEO))?.fileName, "甲.srt");
  assert.deepEqual(await store.replace(VIDEO, null), { previous: record("甲.srt") });
  assert.deepEqual(await driver.getAll(), []);
  assert.equal(await store.restore(VIDEO, null), true);
});

test("库里的行不信：视频键对不上、字幕条目不像样的当作没有，记下的视频信息不像样就不用它", async () => {
  const good = { ...record("好.srt"), info: sampleInfo(REF) };
  const badInfo = { ...record("坏信息.srt", OTHER), info: { title: 1 } as never };
  const { store } = harness([good, badInfo]);
  assert.deepEqual(await store.get(VIDEO), good);
  const kept = await store.get(OTHER);
  assert.equal(kept?.fileName, "坏信息.srt");
  assert.equal(kept && "info" in kept, false);

  for (const broken of [
    { ...record("空.srt"), cues: [] },
    { ...record("坏条目.srt"), cues: [{ start: -1, duration: 1, text: "x" }] },
    { ...record("坏条目.srt"), cues: [{ start: 0, duration: 1, text: 3 }] },
    { ...record("格式.srt"), format: "ass" },
    { ...record("名字.srt"), fileName: 7 },
  ]) {
    const { store: other } = harness([broken as never]);
    assert.equal(await other.get(VIDEO), null, JSON.stringify(broken));
  }
  const { store: misplaced } = harness([{ ...record("别处.srt"), videoKey: OTHER }]);
  assert.equal(await misplaced.get(VIDEO), null);
});

test("清除缓存之前开始的导入照样存下；清除全部数据之前开始的不写", async () => {
  const guard = createClearGuard();
  const { store, driver } = harness([], guard);

  const before = guard.epoch();
  await guard.clear("cache", () => undefined);
  assert.deepEqual(await store.replace(VIDEO, record("甲.srt"), { since: before }), { previous: null }, "清除缓存不动导入的字幕");

  const started = guard.epoch();
  await guard.clear("all", () => driver.clear());
  assert.equal(await store.replace(VIDEO, record("乙.srt"), { since: started }), null);
  assert.equal(await store.restore(VIDEO, record("甲.srt"), { since: started }), false);
  assert.deepEqual(await driver.getAll(), []);
});
