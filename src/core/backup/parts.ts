// 备份分段：扩展的单条消息有大小上限，整份备份大了一次传不过去，按记录切成几段经长连接传。
// 一条译文本身就超过一段时按段再切成几条同主键的；导出那头按原样拼回，导入那头交给译文合并（只补本机缺的段），结果和整份合并一样。
import type { TranslationRecord } from "../notes/records.ts";
import { RECORD_KINDS, type BackupContents, type RecordKind } from "./records.ts";

/**
 * 一段最多这么多字符（按 JSON 文本的长度算）。浏览器的上限按字节算：一个字符最多三个字节，
 * 一段远小于上限，传起来也不会一下占太多内存。
 */
export const PART_BUDGET = 8 * 1024 * 1024;

export type BackupPart = { readonly [K in RecordKind]: { readonly kind: K; readonly records: BackupContents[K] } }[RecordKind];

interface Sized<T> {
  readonly record: T;
  readonly size: number;
}

/** 一条译文太大就按段切成几条同主键的，每条都不超过 budget（只有一段就超过的，那一段单独一条）。 */
function translationPieces(record: TranslationRecord, budget: number): Sized<TranslationRecord>[] {
  const whole = JSON.stringify(record).length;
  if (whole <= budget) return [{ record, size: whole }];
  const base = JSON.stringify({ ...record, segments: {} }).length;
  const room = Math.max(budget - base, 1);
  const pieces: Sized<TranslationRecord>[] = [];
  let segments: Record<string, string> = {};
  let size = 0;
  const flush = (): void => {
    pieces.push({ record: { ...record, segments }, size: base + size });
    segments = {};
    size = 0;
  };
  for (const [hash, text] of Object.entries(record.segments)) {
    // 键、值、冒号和逗号。
    const length = JSON.stringify(hash).length + JSON.stringify(text).length + 2;
    if (size > 0 && size + length > room) flush();
    segments[hash] = text;
    size += length;
  }
  if (size > 0) flush();
  return pieces;
}

function sized(kind: RecordKind, record: unknown, budget: number): Sized<unknown>[] {
  if (kind === "translations") return translationPieces(record as TranslationRecord, budget);
  return [{ record, size: JSON.stringify(record).length }];
}

/** 按类、按原来的顺序切段，每段不超过 budget；没有记录的类不出段。 */
export function splitBackup(contents: BackupContents, budget = PART_BUDGET): BackupPart[] {
  const parts: BackupPart[] = [];
  for (const kind of RECORD_KINDS) {
    let records: unknown[] = [];
    let size = 0;
    const flush = (): void => {
      if (records.length) parts.push({ kind, records } as unknown as BackupPart);
      records = [];
      size = 0;
    };
    for (const record of contents[kind]) {
      for (const piece of sized(kind, record, budget)) {
        // 逗号也算上。
        if (records.length && size + piece.size + 1 > budget) flush();
        records.push(piece.record);
        size += piece.size + 1;
      }
    }
    flush();
  }
  return parts;
}

/** 导出那头拼回整份：一份导出里主键不重复，相邻两条译文主键相同就是切开的同一条，段按原来的顺序接上。 */
export function joinParts(parts: readonly BackupPart[]): BackupContents {
  const notes: BackupContents["notes"][number][] = [];
  const overviews: BackupContents["overviews"][number][] = [];
  const qa: BackupContents["qa"][number][] = [];
  const translations: TranslationRecord[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case "notes":
        for (const record of part.records) notes.push(record);
        break;
      case "overviews":
        for (const record of part.records) overviews.push(record);
        break;
      case "qa":
        for (const record of part.records) qa.push(record);
        break;
      case "translations":
        for (const record of part.records) {
          const last = translations.at(-1);
          if (last?.id === record.id) translations[translations.length - 1] = { ...last, segments: { ...last.segments, ...record.segments } };
          else translations.push(record);
        }
        break;
    }
  }
  return { notes, overviews, qa, translations };
}
