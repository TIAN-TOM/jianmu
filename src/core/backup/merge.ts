// 备份合并：按记录的主键对上本机的记录，更新时间严格更大才覆盖，平局留本机；只把真正新增或更新的列为待写入。
// 问答记下以后不改，只补本机没有的。合并只加和改，本机多出来的记录原样留着，同一份备份导入几次结果都一样。
import type { NoteRecord, OverviewRecord, QaRecord, TranslationRecord } from "../notes/records.ts";
import { SEGMENTS_MAX, type BackupContents } from "./records.ts";

export interface MergeResult<T> {
  /** 合并后的全集。 */
  readonly all: T[];
  /** 要写进本机的：新增的和被备份里较新的版本替换的。 */
  readonly changed: T[];
  readonly added: number;
  readonly updated: number;
  /** 新增和更新的主键：分段导入时页面按主键去重，同一条在后面几段又改了也只算一次。 */
  readonly addedKeys: string[];
  readonly updatedKeys: string[];
}

function resultOf<T>(byKey: ReadonlyMap<string, T>, localKeys: ReadonlySet<string>, changed: ReadonlyMap<string, T>): MergeResult<T> {
  const addedKeys: string[] = [];
  const updatedKeys: string[] = [];
  for (const key of changed.keys()) (localKeys.has(key) ? updatedKeys : addedKeys).push(key);
  return { all: [...byKey.values()], changed: [...changed.values()], added: addedKeys.length, updated: updatedKeys.length, addedKeys, updatedKeys };
}

export interface MergedBackup {
  readonly notes: MergeResult<NoteRecord>;
  readonly overviews: MergeResult<OverviewRecord>;
  readonly qa: MergeResult<QaRecord>;
  readonly translations: MergeResult<TranslationRecord>;
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
  return resultOf(byKey, localKeys, changed);
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

/**
 * 译文和整理后的字幕按字幕版本（主键）合并：本机没有这一版就整条加上；有的话只补本机缺的段，
 * 本机已有的段留本机的（可能是后来重新生成的）。补不出新段就不算变化，同一份备份导入几次结果都一样。
 * 合并后每条最多 SEGMENTS_MAX 段：文件里同一版重复好几条也撑不大。更新时间不信文件：本机已有的那条保留本机的时间，
 * 新加的不晚于 now，免得一条记录永远排在本机重新生成的前面。
 */
export function mergeTranslations(local: readonly TranslationRecord[], incoming: readonly TranslationRecord[], now = Number.POSITIVE_INFINITY): MergeResult<TranslationRecord> {
  const byKey = new Map<string, TranslationRecord>();
  for (const record of local) byKey.set(record.id, record);
  const localKeys = new Set(byKey.keys());
  const changed = new Map<string, TranslationRecord>();
  for (const record of incoming) {
    const current = byKey.get(record.id);
    if (!current) {
      const added = { ...record, updatedAt: Math.min(record.updatedAt, now) };
      byKey.set(record.id, added);
      changed.set(record.id, added);
      continue;
    }
    const room = SEGMENTS_MAX - Object.keys(current.segments).length;
    if (room <= 0) continue;
    const missing: [string, string][] = [];
    for (const entry of Object.entries(record.segments)) {
      if (missing.length >= room) break;
      if (!Object.hasOwn(current.segments, entry[0])) missing.push(entry);
    }
    if (!missing.length) continue;
    // 补的段接在本机的后面：分段导入时一条译文分几次补进来，段的顺序和文件里一样。
    const merged: TranslationRecord = { ...current, segments: { ...current.segments, ...Object.fromEntries(missing) } };
    byKey.set(record.id, merged);
    changed.set(record.id, merged);
  }
  return resultOf(byKey, localKeys, changed);
}

export function mergeBackup(local: BackupContents, incoming: BackupContents): MergedBackup {
  return {
    notes: mergeNotes(local.notes, incoming.notes),
    overviews: mergeOverviews(local.overviews, incoming.overviews),
    qa: mergeQa(local.qa, incoming.qa),
    translations: mergeTranslations(local.translations, incoming.translations),
  };
}
