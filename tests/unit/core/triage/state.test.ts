import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STORAGE_KEY,
  emptyState,
  findItem,
  normalizeState,
  withList,
  withOfficial,
  type OfficialRecord,
  type TriageItem,
} from "../../../../src/core/triage/state.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";

const keyOf = (name: string): VideoKey =>
  videoKey({ platform: "bilibili", videoId: `BV1Sample${name.padStart(3, "0")}` });

const item = (name: string): TriageItem => ({
  videoKey: keyOf(name),
  title: `标题 ${name}`,
  ownerName: "UP 主",
  duration: 600,
  progress: 0,
  finished: false,
  pageCount: 1,
  available: true,
});

const OK = (summary = "官方总摘要"): OfficialRecord => ({
  status: "ok",
  summary,
  outline: [{ title: "第一段", timestamp: 0, points: [] }],
});

test("存储键以 jianmu_ 开头", () => {
  assert.equal(STORAGE_KEY, "jianmu_triage");
});

test("换一份列表时，不在新列表里的视频连同官方总结一起清掉", () => {
  const before = withOfficial(withOfficial(emptyState(), keyOf("A"), OK()), keyOf("GON"), { status: "none" });
  const after = withList(before, { items: [item("A"), item("B")], count: 2, fetchedAt: 9 });
  assert.deepEqual(Object.keys(after.official), [keyOf("A")]);
  assert.deepEqual(after.list?.items.map((video) => video.videoKey), [keyOf("A"), keyOf("B")]);
  assert.equal(after.list?.fetchedAt, 9);
  assert.equal(findItem(after, keyOf("B"))?.videoKey, keyOf("B"));
  assert.equal(findItem(after, keyOf("GON")), null);
});

test("存储读出来是坏的也能用：缺字段、类型不对都回到空状态", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState("坏数据"), emptyState());
  const state = normalizeState({
    list: { items: [item("A"), null, { title: "没有视频键" }] },
    official: { [keyOf("A")]: OK(), [keyOf("B")]: "坏记录" },
  });
  assert.deepEqual(state.list?.items.map((video) => video.videoKey), [keyOf("A")]);
  assert.deepEqual(Object.keys(state.official), [keyOf("A")]);
});
