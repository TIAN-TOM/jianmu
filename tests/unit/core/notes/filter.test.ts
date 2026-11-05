import assert from "node:assert/strict";
import { test } from "node:test";
import { filterNotes } from "../../../../src/core/notes/filter.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const note = (extra: Partial<NoteRecord>): NoteRecord => ({
  id: "note_x",
  kind: "note",
  origin: "user",
  video: videoKey({ platform: "bilibili", videoId: "BV1Sample000" }),
  snapshot: { title: "", author: "" },
  atSec: 0,
  text: "",
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const NOTE_A = note({
  id: "note_a",
  snapshot: { title: "第一个视频", author: "UP 甲" },
  atSec: 65,
  text: "较早的一条",
});

const NOTE_C = note({
  id: "note_c",
  video: videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 2 }),
  snapshot: { title: "第二个视频", author: "UP 乙" },
  atSec: 120,
  text: "另一部的笔记",
});

test("笔记搜索匹配正文、标题和 UP 主", () => {
  assert.equal(filterNotes([NOTE_A, NOTE_C], "另一部").length, 1);
  assert.equal(filterNotes([NOTE_A, NOTE_C], "UP 乙")[0]?.id, "note_c");
  assert.equal(filterNotes([NOTE_A, NOTE_C], "第一个")[0]?.id, "note_a");
  assert.equal(filterNotes([NOTE_A], "   ").length, 1);
  assert.equal(filterNotes([NOTE_A], "没有这个词").length, 0);
});

test("搜索认时间点和视频编号，平台名和分 P 不算内容", () => {
  assert.deepEqual(filterNotes([NOTE_A, NOTE_C], "1:05"), [NOTE_A]);
  assert.deepEqual(filterNotes([NOTE_A, NOTE_C], "bv1sample001"), [NOTE_C]);
  assert.deepEqual(filterNotes([NOTE_A, NOTE_C], "bilibili"), []);
  assert.deepEqual(filterNotes([NOTE_A, NOTE_C], "p2"), []);
});

test("列表不是数组或夹着坏记录时跳过", () => {
  assert.deepEqual(filterNotes(null, "词"), []);
  assert.deepEqual(filterNotes([null, NOTE_A, undefined], ""), [NOTE_A]);
});
