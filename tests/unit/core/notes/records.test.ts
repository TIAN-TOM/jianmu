import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAnalysisFailures, noteList, videoIdOf } from "../../../../src/core/notes/records.ts";

test("失败区间：缺的字段补成能用的值，结束不早于开始，原因截到一句话", () => {
  assert.deepEqual(normalizeAnalysisFailures(null), []);
  assert.deepEqual(normalizeAnalysisFailures([{ index: "2", startSeconds: 90.9, endSeconds: 30, reason: "  超时  " }, null]), [
    { index: 2, startSeconds: 90, endSeconds: 90, reason: "超时" },
    { index: 0, startSeconds: 0, endSeconds: 0 },
  ]);
  const [long] = normalizeAnalysisFailures([{ reason: "长".repeat(300) }]);
  assert.equal(long?.reason?.length, 200);
  assert.deepEqual(normalizeAnalysisFailures([{ startSeconds: Infinity }]), []);
});

test("视频编号从键里取，键认不出时原样用键", () => {
  assert.equal(videoIdOf("bilibili:BV1Sample000:p2"), "BV1Sample000");
  assert.equal(videoIdOf("youtube:sample_id"), "sample_id");
  assert.equal(videoIdOf("认不出"), "认不出");
  assert.equal(videoIdOf(undefined), "");
});

test("笔记列表只留对象", () => {
  assert.deepEqual(noteList(undefined), []);
  assert.deepEqual(noteList([null, { text: "留下" }, undefined]), [{ text: "留下" }]);
});
