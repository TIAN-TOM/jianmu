// 备份合并：按记录的主键对上本机的记录，更新时间严格更大才覆盖，平局留本机；只把真正新增或更新的列为待写入。
// 问答记下以后不改，只补本机没有的。合并只加和改，本机多出来的记录原样留着，同一份备份导入几次结果都一样。
import type { NoteRecord, OverviewRecord } from "../notes/records.ts";
import type { QaRecord } from "../qa/records.ts";
import type { BackupContents } from "./records.ts";

export interface MergeResult<T> {
  /** 合并后的全集。 */
  readonly all: T[];
  /** 要写进本机的：新增的和被备份里较新的版本替换的。 */
  readonly changed: T[];
  readonly added: number;
  readonly updated: number;
}

export interface MergedBackup {
  readonly notes: MergeResult<NoteRecord>;
  readonly overviews: MergeResult<OverviewRecord>;
  readonly qa: MergeResult<QaRecord>;
}

function mergeBy<T>(
  local: readonly T[],
  incoming: readonly T[],
  keyOf: (record: T) => string,
  replaces: (incoming: T, current: T) => boolean,
): MergeResult<T> {
  const byKey = new Map<string, T>();
  for (const record of local) byKey.set(keyOf(record), record);
  const localKeys = new Set(byKey.keys());
  const changed = new Map<string, T>();
  for (const record of incoming) {
    const key = keyOf(record);
    const current = byKey.get(key);
    if (current !== undefined && !replaces(record, current)) continue;
    byKey.set(key, record);
    changed.set(key, record);
  }
  const updated = [...changed.keys()].filter((key) => localKeys.has(key)).length;
  return { all: [...byKey.values()], changed: [...changed.values()], added: changed.size - updated, updated };
}

// 严格大于：重放同一份备份不会再写一遍，导出以后本机又改过的也不会被备份盖回去。
const newer = <T extends { readonly updatedAt: number }>(incoming: T, current: T): boolean =>
  incoming.updatedAt > current.updatedAt;

export function mergeNotes(local: readonly NoteRecord[], incoming: readonly NoteRecord[]): MergeResult<NoteRecord> {
  return mergeBy(local, incoming, (note) => note.id, newer);
}

export function mergeOverviews(
  local: readonly OverviewRecord[],
  incoming: readonly OverviewRecord[],
): MergeResult<OverviewRecord> {
  return mergeBy(local, incoming, (record) => record.videoKey, newer);
}

export function mergeQa(local: readonly QaRecord[], incoming: readonly QaRecord[]): MergeResult<QaRecord> {
  return mergeBy(local, incoming, (entry) => entry.id, () => false);
}

export function mergeBackup(local: BackupContents, incoming: BackupContents): MergedBackup {
  return {
    notes: mergeNotes(local.notes, incoming.notes),
    overviews: mergeOverviews(local.overviews, incoming.overviews),
    qa: mergeQa(local.qa, incoming.qa),
  };
}
