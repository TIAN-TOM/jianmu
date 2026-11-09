// 备份合并：按主键对上本机记录，更新时间严格更大才覆盖，只写真正变了的；问答只补本机没有的。导出再导入幂等。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildBackup, readBackup } from "../../../../src/core/backup/format.ts";
import { LEGACY_BACKUP_KIND } from "../../../../src/core/backup/legacy-reader.ts";
import { mergeBackup, mergeNotes, mergeOverviews, mergeQa } from "../../../../src/core/backup/merge.ts";
import type { BackupContents, ImportedBackup } from "../../../../src/core/backup/records.ts";
import type { NoteRecord, OverviewRecord, QaRecord } from "../../../../src/core/notes/records.ts";
import { parseVideoKey, videoKey } from "../../../../src/core/video-ref.ts";

const KEY_A = videoKey({ platform: "bilibili", videoId: "BV1Sample000" });
const KEY_B = videoKey({ platform: "bilibili", videoId: "BV1Sample001" });
const EXPORTED_AT = Date.UTC(2026, 10, 1);
const EMPTY: BackupContents = { notes: [], overviews: [], qa: [] };

function note(id: string, updatedAt: number, text: string, extra: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id,
    kind: "note",
    origin: "user",
    video: KEY_A,
    snapshot: { title: "番茄搭架子入门", author: "菜园实验室" },
    atSec: 0,
    text,
    createdAt: updatedAt,
    updatedAt,
    ...extra,
  };
}

function overview(key: typeof KEY_A, updatedAt: number, title = "章节"): OverviewRecord {
  return {
    schemaVersion: 1,
    videoKey: key,
    snapshot: { title: "番茄搭架子入门", author: "菜园实验室" },
    analysis: { chapters: [{ title, summary: "", timestampSeconds: 0, timestamp: "0:00" }], keyQuotes: [] },
    updatedAt,
  };
}

const ENTRY: QaRecord = Object.freeze({
  id: "qa_1700000000000_abcdef",
  video: KEY_A,
  question: "视频建议早上做什么？",
  answer: "早上先做最难的一件事 [00:12]。",
  citations: [{ startSeconds: 12, quote: "早上先做最难的一件事" }],
  clickable: [12],
  derived: { basis: { source: "legacy-unknown" as const } },
  createdAt: 1700000000000,
});

function read(payload: unknown): ImportedBackup {
  const result = readBackup(payload);
  if (!result.ok) assert.fail(`读备份失败：${result.code} ${result.detail ?? ""}`);
  return result.value;
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/legacy-backups/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

test("备份合并：updatedAt 平局保留本地，缺视频键的概览补键后可写入", () => {
  const incoming = read(buildBackup({ notes: [note("n1", 100, "备份版")] }, EXPORTED_AT)).contents;
  const merged = mergeNotes([note("n1", 100, "本地改过")], incoming.notes);
  assert.equal(merged.all.find((item) => item.id === "n1")?.text, "本地改过", "平局不能让备份反向覆盖本地");
  assert.deepEqual(merged.changed, []);

  // 旧备份里的概览缺了记录键，只剩视频号和分 P。
  const legacy = fixture("digest-for-bilibili.json");
  const learning = legacy["learning"] as Record<string, unknown>[];
  const withoutKey = learning.map(({ learningId: _dropped, ...rest }) => rest);
  const imported = read({ ...legacy, learning: withoutKey }).contents;
  const added = mergeOverviews([], imported.overviews);
  assert.equal(added.added, 2);
  assert.ok(
    added.changed.every((record) => parseVideoKey(record.videoKey) !== null),
    "推出视频键就要写进记录，否则统计虚报、写入被仓储滤掉",
  );
});

test("备份不含 AI 草稿、版本号和内容来源，恢复时较新的覆盖、本机多出来的保留", () => {
  const stored = { ...note("note_a", 1000, "较早的一条"), aiDraft: { text: "未确认的草稿" }, pending: true, revision: 3, contentSource: "user" };
  const backup = buildBackup({ notes: [stored], overviews: [overview(KEY_A, 5000, "新")] }, EXPORTED_AT);
  const [exported] = backup.notes;
  for (const field of ["aiDraft", "pending", "revision", "contentSource"]) {
    assert.equal(Object.hasOwn(exported ?? {}, field), false, field);
  }
  assert.doesNotMatch(JSON.stringify(backup), /sk-/);

  assert.equal(readBackup({ foo: 1 }).ok, false);
  assert.deepEqual(readBackup({ ...backup, version: 99 }), { ok: false, code: "BACKUP_TOO_NEW" });

  const merged = mergeBackup(
    { notes: [note("note_a", 9000, "本机较新"), note("keep_me", 10, "留下")], overviews: [overview(KEY_A, 1000, "旧")], qa: [] },
    read(backup).contents,
  );
  assert.equal(merged.notes.all.find((item) => item.id === "keep_me")?.text, "留下");
  assert.equal(merged.notes.all.find((item) => item.id === "note_a")?.text, "本机较新");
  assert.equal(merged.overviews.all[0]?.updatedAt, 5000);
  assert.equal(merged.notes.added, 0);
  assert.equal(merged.overviews.updated, 1);
});

test("合并备份只把真正新增或更新的记录列为待写入", () => {
  const notes = mergeNotes([note("n1", 500, "本地")], [note("n1", 100, "备份里更旧"), note("n2", 100, "新增")]);
  assert.deepEqual(notes.changed.map((item) => item.id), ["n2"]);
  const local = overview(KEY_A, 500);
  const overviews = mergeOverviews([local], [overview(KEY_A, 100), overview(KEY_B, 100)]);
  assert.deepEqual(overviews.changed.map((record) => record.videoKey), [KEY_B]);
  assert.equal(overviews.all.length, 2, "全集仍然给出，统计口径不变");

  const empty = mergeOverviews([local], []);
  assert.deepEqual(empty.changed, [], "备份没带概览时一条都不写");
});

test("导出的备份带问答历史，只留认识的字段，认不出的整条丢掉", () => {
  const source = {
    qa: [
      { ...ENTRY, extra: "不该带走", truncated: true, clickable: [12, "00:12", -1, Number.NaN] },
      { ...ENTRY, id: "note_1" },
      { ...ENTRY, id: "qa_2", video: "not-a-video" },
      { ...ENTRY, id: "qa_3", answer: 42 },
      null,
    ],
  };
  const backup = buildBackup(source as unknown as { qa: QaRecord[] }, EXPORTED_AT);
  assert.deepEqual(backup.qa, [{ ...ENTRY, truncated: true }]);
});

test("旧备份没有 qa 照常导入；qa 不是数组时整份拒绝", () => {
  const base = { kind: LEGACY_BACKUP_KIND, schemaVersion: 2, notes: [] };
  assert.equal(readBackup(base).ok, true);
  assert.deepEqual(readBackup({ ...base, qa: { id: "qa_1" } }), { ok: false, code: "BACKUP_DAMAGED", detail: "qa" });
});

test("合并问答只补本机没有的，本机已有的以本机为准", () => {
  const local = [{ ...ENTRY, answer: "本机的回答" }];
  const incoming = [{ ...ENTRY, answer: "备份里的回答" }, { ...ENTRY, id: "qa_new" }, { ...ENTRY, id: "qa_new" }];
  const merged = mergeQa(local, incoming);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.changed.map((entry) => entry.id), ["qa_new"]);
  assert.equal(merged.all.find((entry) => entry.id === ENTRY.id)?.answer, "本机的回答");
});

test("导出再导入幂等：同一份备份导入两次，第二次什么都不写，本机记录不变", () => {
  const local: BackupContents = {
    notes: [note("n1", 100, "一"), note("n2", 200, "二")],
    overviews: [overview(KEY_A, 300), overview(KEY_B, 400)],
    qa: [ENTRY],
  };
  const backup = buildBackup(local, EXPORTED_AT);
  const imported = read(JSON.parse(JSON.stringify(backup))).contents;
  assert.deepEqual(imported, local, "导出的文件原样导回来是同一份记录");

  const first = mergeBackup(EMPTY, imported);
  assert.deepEqual([first.notes.added, first.overviews.added, first.qa.added], [2, 2, 1]);
  const afterFirst: BackupContents = { notes: first.notes.all, overviews: first.overviews.all, qa: first.qa.all };
  const second = mergeBackup(afterFirst, imported);
  for (const part of [second.notes, second.overviews, second.qa]) {
    assert.deepEqual([part.changed, part.added, part.updated], [[], 0, 0]);
  }
  assert.deepEqual(buildBackup(afterFirst, EXPORTED_AT), backup);
});

test("旧备份导入以后再导出，新备份导回来是同一份记录，再合并一次什么都不写", () => {
  for (const name of ["existing-version.json", "digest-for-bilibili.json"]) {
    const imported = read(fixture(name)).contents;
    const first = mergeBackup(EMPTY, imported);
    const stored: BackupContents = { notes: first.notes.all, overviews: first.overviews.all, qa: first.qa.all };
    const again = read(JSON.parse(JSON.stringify(buildBackup(stored, EXPORTED_AT)))).contents;
    assert.deepEqual(again, stored, name);
    const second = mergeBackup(stored, again);
    assert.equal(second.notes.changed.length + second.overviews.changed.length + second.qa.changed.length, 0, name);
  }
});
