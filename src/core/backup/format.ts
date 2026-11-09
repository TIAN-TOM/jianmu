// 简幕自己的备份格式：导出、先认格式再读。旧格式交给 legacy-reader，合并在 merge。
// 备份只带笔记、概览和问答；密钥、设置、提示词和链接这类字段一律不进文件，记录过一遍校验只留认得的字段。
import { fail, ok, type Result } from "../errors.ts";
import type { NoteRecord, OverviewRecord, QaRecord } from "../notes/records.ts";
import { isLegacyBackup, readLegacyBackup } from "./legacy-reader.ts";
import {
  checkNote,
  checkOverview,
  checkQa,
  isFields,
  keepValid,
  RECORD_KINDS,
  type BackupContents,
  type Fields,
  type ImportedBackup,
  type RecordKind,
} from "./records.ts";

export const BACKUP_KIND = "jianmu-backup";
// 备份版本只管这份文件的形状，和数据库版本、记录版本各自递增。
export const BACKUP_VERSION = 1;

export interface Backup extends BackupContents {
  readonly kind: typeof BACKUP_KIND;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
}

export interface BackupSource {
  readonly notes?: readonly NoteRecord[];
  readonly overviews?: readonly OverviewRecord[];
  readonly qa?: readonly QaRecord[];
}

function isoTime(ms: number): string {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** 导出：三类记录各过一遍校验，导出的文件原样导回来得到同一份记录。 */
export function buildBackup(source: BackupSource, exportedAt: number): Backup {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: isoTime(exportedAt),
    notes: keepValid(source.notes ?? [], checkNote).kept,
    overviews: keepValid(source.overviews ?? [], checkOverview).kept,
    qa: keepValid(source.qa ?? [], checkQa).kept,
  };
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
  return ok({
    format: "jianmu",
    contents: { notes: notes.kept, overviews: overviews.kept, qa: qa.kept },
    skipped: { notes: notes.skipped, overviews: overviews.skipped, qa: qa.skipped },
    promptsDropped: false,
  });
}

/**
 * 导入先认格式：简幕的新格式走这里，旧格式交给旧格式读取器；版本更高的报来自更新的版本，都不是的报认不出。
 * 整份结构坏了（该是列表的不是列表）才整份拒绝，detail 是坏的那一类；单条记录坏了只跳过并计数。
 */
export function readBackup(payload: unknown): Result<ImportedBackup> {
  if (!isFields(payload)) return fail("BACKUP_UNRECOGNIZED");
  if (payload.kind === BACKUP_KIND) return readCurrent(payload);
  if (isLegacyBackup(payload)) return readLegacyBackup(payload);
  return fail("BACKUP_UNRECOGNIZED");
}
