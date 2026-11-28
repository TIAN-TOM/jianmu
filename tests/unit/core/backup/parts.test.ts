// 备份分段：每段不超过上限，按类按原顺序切；一条译文太大时按段切成几条同主键的，导出那头拼回原样，
// 导入那头一段段合并和整份一次合并结果一样；拼成文件的文本和整份 JSON 一字不差。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKUP_KIND, BACKUP_VERSION, backupText, buildBackup, type Backup } from "../../../../src/core/backup/format.ts";
import { mergeNotes, mergeTranslations } from "../../../../src/core/backup/merge.ts";
import { joinParts, splitBackup } from "../../../../src/core/backup/parts.ts";
import type { BackupContents } from "../../../../src/core/backup/records.ts";
import { translationId, type NoteRecord, type TranslationRecord } from "../../../../src/core/notes/records.ts";
import { SAMPLE_KEY as VIDEO } from "../../../helpers/sample-videos.ts";

const TRANSCRIPT = { video: VIDEO, kind: "auto" as const, lang: "zh-CN", fingerprint: "fp-parts" };

const note = (index: number, text = `笔记 ${index}`): NoteRecord => ({
  id: `note_${index}`,
  kind: "note",
  origin: "user",
  video: VIDEO,
  snapshot: { title: "样例", author: "作者" },
  atSec: index,
  text,
  createdAt: index,
  updatedAt: index + 1,
});

function translation(target: TranslationRecord["target"], count: number, text = "一段译文"): TranslationRecord {
  const transcript = { ...TRANSCRIPT, fingerprint: `fp-${target}` };
  return {
    id: translationId(transcript, target),
    video: VIDEO,
    transcript,
    target,
    // 有的键全是数字：对象里这类键的顺序和别的不一样，拼回来也要一样。
    segments: Object.fromEntries(Array.from({ length: count }, (_, index) => [index % 3 ? `${index}`.padStart(8, "0") : `ab${index}`.padEnd(8, "c"), `${text} ${index}\n第二行`])),
    derived: { basis: { source: "transcript", transcript }, gen: { feature: "rewrite", promptVersion: "v1", model: "m", effort: "off" } },
    updatedAt: 50,
  };
}

const empty: BackupContents = { notes: [], overviews: [], qa: [], translations: [] };

test("每段不超过上限，按类按原顺序切，没有记录的类不出段", () => {
  const contents = { ...empty, notes: Array.from({ length: 40 }, (_, index) => note(index)), translations: [translation("en", 30), translation("tidy", 5)] };
  const budget = 1500;
  const parts = splitBackup(contents, budget);
  assert.ok(parts.length > 3);
  for (const part of parts) assert.ok(JSON.stringify(part.records).length <= budget, `${part.kind} 段超了`);
  assert.deepEqual([...new Set(parts.map((part) => part.kind))], ["notes", "translations"]);
  assert.deepEqual(joinParts(parts), contents);
  assert.deepEqual(splitBackup(empty), []);
});

test("一条译文比一段还大：按段切成几条同主键的，每条不超过上限，拼回来段和顺序都一样", () => {
  const big = translation("en", 200);
  const parts = splitBackup({ ...empty, translations: [big, translation("tidy", 3)] }, 2000);
  const pieces = parts.flatMap((part) => (part.kind === "translations" ? part.records : []));
  assert.ok(pieces.filter((piece) => piece.id === big.id).length > 3);
  for (const piece of pieces) assert.ok(JSON.stringify(piece).length <= 2000);
  const [joined] = joinParts(parts).translations;
  assert.deepEqual(joined, big);
  assert.deepEqual(Object.keys(joined?.segments ?? {}), Object.keys(big.segments));
  assert.equal(JSON.stringify(joined), JSON.stringify(big));
});

test("一段段合并和整份一次合并结果一样：切开的译文补进本机，本机已有的段留本机的；笔记按主键覆盖", () => {
  const big = translation("en", 120);
  const local = { ...translation("en", 10, "本机重新翻的"), updatedAt: 70 };
  const whole = mergeTranslations([local], [big], 60);
  let current: TranslationRecord[] = [local];
  for (const part of splitBackup({ ...empty, translations: [big] }, 1500)) {
    assert.equal(part.kind, "translations");
    const merged = mergeTranslations(current, part.kind === "translations" ? part.records : [], 60);
    current = merged.all;
  }
  assert.deepEqual(current, whole.all);

  const notes = Array.from({ length: 20 }, (_, index) => note(index));
  let localNotes = [note(3, "本机改过"), { ...note(4), updatedAt: 0 }];
  const keys = { added: new Set<string>(), updated: new Set<string>() };
  for (const part of splitBackup({ ...empty, notes }, 600)) {
    const merged = mergeNotes(localNotes, part.kind === "notes" ? part.records : []);
    merged.addedKeys.forEach((key) => keys.added.add(key));
    merged.updatedKeys.forEach((key) => keys.updated.add(key));
    localNotes = merged.all;
  }
  const once = mergeNotes([note(3, "本机改过"), { ...note(4), updatedAt: 0 }], notes);
  assert.deepEqual(new Set(localNotes), new Set(once.all));
  assert.deepEqual([keys.added.size, keys.updated.size], [once.added, once.updated]);
});

test("拼成文件的文本按块写出，拼起来和整份 JSON 一字不差", () => {
  const backups: Backup[] = [
    buildBackup({}, Date.UTC(2026, 10, 19)),
    buildBackup({ notes: [note(1), note(2, "带\n换行和 \"引号\" 的笔记")], translations: [translation("en", 4)] }, Date.UTC(2026, 10, 19)),
  ];
  for (const backup of backups) {
    assert.equal(backup.kind, BACKUP_KIND);
    assert.equal(backup.version, BACKUP_VERSION);
    assert.equal(backupText(backup).join(""), `${JSON.stringify(backup, null, 2)}\n`);
  }
});
