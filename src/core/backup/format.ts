// 简幕自己的备份格式：导出、先认格式再读。旧格式交给 legacy-reader，合并在 merge。
// 备份带笔记、概览、问答，第 2 版起加上译文和整理后的字幕（花额度换来的，重装就没了）；
// 密钥、设置、提示词和链接这类字段一律不进文件，记录过一遍校验只留认得的字段。第 1 版的备份照常能读。
import { isRecord } from "../../shared/guards.ts";
import { fail, ok, type Result } from "../errors.ts";
import type { NoteRecord, OverviewRecord, QaRecord, TranslationRecord } from "../notes/records.ts";
import { isLegacyBackup, readLegacyBackup } from "./legacy-reader.ts";
import {
  checkNote,
  checkOverview,
  checkQa,
  checkTranslation,
  keepValid,
  RECORD_KINDS,
  type BackupContents,
  type Fields,
  type ImportedBackup,
  type RecordKind,
} from "./records.ts";

export const BACKUP_KIND = "jianmu-backup";
// 备份版本只管这份文件的形状，和数据库版本、记录版本各自递增。第 2 版加了 translations。
export const BACKUP_VERSION = 2;

export interface Backup extends BackupContents {
  readonly kind: typeof BACKUP_KIND;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
}

export interface BackupSource {
  readonly notes?: readonly NoteRecord[];
  readonly overviews?: readonly OverviewRecord[];
  readonly qa?: readonly QaRecord[];
  readonly translations?: readonly TranslationRecord[];
}

function isoTime(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** 导出：四类记录各过一遍校验，导出的文件原样导回来得到同一份记录。 */
export function buildBackup(source: BackupSource, exportedAt: number): Backup {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: isoTime(exportedAt),
    notes: keepValid(source.notes ?? [], checkNote).kept,
    overviews: keepValid(source.overviews ?? [], checkOverview).kept,
    qa: keepValid(source.qa ?? [], checkQa).kept,
    translations: keepValid(source.translations ?? [], checkTranslation).kept,
  };
}

/**
 * 导出的文件按块写出，拼起来和 JSON.stringify(backup, null, 2) 加一个换行一字不差。
 * 一条记录一块：备份再大也不用先拼成一个字符串，浏览器单个字符串有长度上限。
 */
export function backupText(backup: Backup): string[] {
  const chunks = [`{\n  "kind": ${JSON.stringify(backup.kind)},\n  "version": ${JSON.stringify(backup.version)},\n  "exportedAt": ${JSON.stringify(backup.exportedAt)}`];
  for (const kind of RECORD_KINDS) {
    const list: readonly unknown[] = backup[kind];
    if (!list.length) {
      chunks.push(`,\n  ${JSON.stringify(kind)}: []`);
      continue;
    }
    chunks.push(`,\n  ${JSON.stringify(kind)}: [`);
    // 字符串里的换行写成转义，JSON 文本里的换行都是缩进用的。
    list.forEach((record, index) => chunks.push(`${index ? "," : ""}\n    ${JSON.stringify(record, null, 2).replaceAll("\n", "\n    ")}`));
    chunks.push("\n  ]");
  }
  chunks.push("\n}\n");
  return chunks;
}

function readCurrent(payload: Fields): Result<ImportedBackup> {
  const { version } = payload;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return fail("BACKUP_UNRECOGNIZED");
  if (version > BACKUP_VERSION) return fail("BACKUP_TOO_NEW");
  const lists: Partial<Record<RecordKind, readonly unknown[]>> = {};
  for (const kind of RECORD_KINDS) {
    const list = payload[kind];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) return fail("BACKUP_DAMAGED", kind);
    lists[kind] = list;
  }
  const notes = keepValid(lists.notes ?? [], checkNote);
  const overviews = keepValid(lists.overviews ?? [], checkOverview);
  const qa = keepValid(lists.qa ?? [], checkQa);
  // 第 1 版没有这一类，按空的读。
  const translations = keepValid(lists.translations ?? [], checkTranslation);
  return ok({
    format: "jianmu",
    contents: { notes: notes.kept, overviews: overviews.kept, qa: qa.kept, translations: translations.kept },
    skipped: { notes: notes.skipped, overviews: overviews.skipped, qa: qa.skipped, translations: translations.skipped },
    promptsDropped: false,
  });
}

/**
 * 导入先认格式：简幕的新格式走这里，旧格式交给旧格式读取器；版本更高的报来自更新的版本，都不是的报认不出。
 * 整份结构坏了（该是列表的不是列表）才整份拒绝，detail 是坏的那一类；单条记录坏了只跳过并计数。
 */
export function readBackup(payload: unknown): Result<ImportedBackup> {
  if (!isRecord(payload)) return fail("BACKUP_UNRECOGNIZED");
  if (payload.kind === BACKUP_KIND) return readCurrent(payload);
  if (isLegacyBackup(payload)) return readLegacyBackup(payload);
  return fail("BACKUP_UNRECOGNIZED");
}
