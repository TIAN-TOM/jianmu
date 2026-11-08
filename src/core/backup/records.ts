// 备份里三类记录的校验：导出、读新格式、转换旧格式都过这一道。只留记录类型里有的字段，
// 概览过一遍和生成时相同的校验，必填的字段不对就整条丢掉，交给调用方计数。
import { validateAnalysis } from "../ai/validate.ts";
import { validateVerdict } from "../ai/verdict.ts";
import type { LearningAnalysis, LearningVerdict } from "../notes/markdown.ts";
import {
  normalizeAnalysisFailures,
  OVERVIEW_RECORD_VERSION,
  type Basis,
  type Derived,
  type Effort,
  type GenInfo,
  type NoteRecord,
  type NoteSnapshot,
  type OverviewRecord,
} from "../notes/records.ts";
import type { Citation } from "../qa/citations.ts";
import type { QaRecord } from "../qa/records.ts";
import type { CaptionKind } from "../transcript/sources.ts";
import { parseVideoKey, type VideoKey } from "../video-ref.ts";

export interface BackupContents {
  readonly notes: readonly NoteRecord[];
  readonly overviews: readonly OverviewRecord[];
  readonly qa: readonly QaRecord[];
}

export type RecordKind = keyof BackupContents;

export const RECORD_KINDS: readonly RecordKind[] = Object.freeze(["notes", "overviews", "qa"]);

export type SkipCounts = Readonly<Record<RecordKind, number>>;

/** 读完的一份备份：留下的记录和每类跳过的条数。旧备份带着提示词时 promptsDropped 为真，界面据此告诉用户没有导入。 */
export interface ImportedBackup {
  readonly format: "jianmu" | "legacy";
  readonly contents: BackupContents;
  readonly skipped: SkipCounts;
  readonly promptsDropped: boolean;
}

const ID_MAX = 200;
const QA_ID_MAX = 100;
const QA_ID_PREFIX = "qa_";
export const NOTE_TEXT_MAX = 3000;
const TITLE_MAX = 500;
const AUTHOR_MAX = 300;

const CAPTION_KINDS: readonly CaptionKind[] = ["human", "auto", "official-ai", "imported"];
const EFFORTS: readonly Effort[] = ["off", "low", "medium", "high"];

export type Fields = Readonly<Record<string, unknown>>;

export function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** 主键是正常的字符串才收：对象、布尔值这类写进数据库会让整个事务回滚。 */
export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= ID_MAX;
}

export function isQaId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(QA_ID_PREFIX) && value.length <= QA_ID_MAX;
}

function videoOf(value: unknown): VideoKey | null {
  return typeof value === "string" && parseVideoKey(value) ? (value as VideoKey) : null;
}

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

export function snapshotOf(title: unknown, author: unknown, channel?: unknown): NoteSnapshot {
  return {
    title: clip(title, TITLE_MAX),
    author: clip(author, AUTHOR_MAX),
    ...(typeof channel === "string" && channel ? { channel: channel.slice(0, ID_MAX) } : {}),
  };
}

function storedSnapshot(value: unknown): NoteSnapshot {
  return isFields(value) ? snapshotOf(value.title, value.author, value.channel) : snapshotOf("", "");
}

/** 一份列表逐条过 check：留下认得的，坏的只计数，不拖累同一份里的其他记录。 */
export function keepValid<T>(list: readonly unknown[], check: (value: unknown) => T | null): { kept: T[]; skipped: number } {
  const kept: T[] = [];
  let skipped = 0;
  for (const value of list) {
    const record = check(value);
    if (record === null) skipped += 1;
    else kept.push(record);
  }
  return { kept, skipped };
}

const UNKNOWN_BASIS: Derived = Object.freeze({ basis: Object.freeze({ source: "legacy-unknown" }) });

function checkGen(value: unknown): GenInfo | null {
  if (!isFields(value)) return null;
  const { feature, promptVersion, model, effort } = value;
  if (typeof feature !== "string" || typeof promptVersion !== "string" || typeof model !== "string") return null;
  return oneOf(EFFORTS, effort) ? { feature, promptVersion, model, effort } : null;
}

function checkBasis(value: unknown): Basis | null {
  if (!isFields(value)) return null;
  const { source } = value;
  if (source === "transcript") {
    const transcript = value.transcript;
    if (!isFields(transcript)) return null;
    const video = videoOf(transcript.video);
    const { kind, lang, fingerprint } = transcript;
    if (!video || !oneOf(CAPTION_KINDS, kind) || typeof lang !== "string" || typeof fingerprint !== "string") return null;
    return { source, transcript: { video, kind, lang, fingerprint } };
  }
  if (source === "official-summary" || source === "title-description") {
    const video = videoOf(value.video);
    return video && typeof value.fingerprint === "string" ? { source, video, fingerprint: value.fingerprint } : null;
  }
  if (source === "legacy-unknown") {
    return value.hint === "official-summary" ? { source, hint: "official-summary" } : { source };
  }
  return null;
}

/** 依据读不懂时记成未知，不丢整条记录；依据已知却缺生成配置的也只能算未知。 */
export function checkDerived(value: unknown): Derived {
  if (!isFields(value)) return UNKNOWN_BASIS;
  const basis = checkBasis(value.basis);
  const gen = checkGen(value.gen);
  if (!basis) return UNKNOWN_BASIS;
  if (basis.source === "legacy-unknown") return gen ? { basis, gen } : { basis };
  return gen ? { basis, gen } : UNKNOWN_BASIS;
}

/** 结论按生成时的规则重建；依据官方总结写的照旧标明。 */
function checkVerdict(value: unknown): LearningVerdict | null {
  if (!isFields(value)) return null;
  const verdict = validateVerdict(value, { incomplete: value.incomplete === true });
  if (!verdict) return null;
  return value.source === "official" ? { ...verdict, source: "official" } : verdict;
}

function checkAnalysis(value: Fields): LearningAnalysis {
  const { chapters, keyQuotes } = validateAnalysis(value, undefined);
  const verdict = checkVerdict(value.verdict);
  return verdict ? { chapters, keyQuotes, verdict } : { chapters, keyQuotes };
}

/** 正文和原文按上限截断。 */
export function noteRecord(fields: NoteRecord): NoteRecord {
  const { quote, text, ...rest } = fields;
  return {
    ...rest,
    text: text.slice(0, NOTE_TEXT_MAX),
    ...(quote === undefined ? {} : { quote: quote.slice(0, NOTE_TEXT_MAX) }),
  };
}

export function checkNote(value: unknown): NoteRecord | null {
  if (!isFields(value)) return null;
  const { id, kind, origin, snapshot, text, quote, derived, updatedAt } = value;
  const video = videoOf(value.video);
  const atSec = finite(value.atSec);
  if (!isRecordId(id) || kind !== "note" || (origin !== "user" && origin !== "legacy")) return null;
  if (!video || atSec === null || atSec < 0 || typeof text !== "string") return null;
  const createdAt = finite(value.createdAt) ?? finite(updatedAt) ?? 0;
  return noteRecord({
    id,
    kind,
    origin,
    video,
    snapshot: storedSnapshot(snapshot),
    atSec,
    text,
    ...(typeof quote === "string" ? { quote } : {}),
    ...(derived === undefined ? {} : { derived: checkDerived(derived) }),
    createdAt,
    updatedAt: finite(updatedAt) ?? createdAt,
  });
}

export function overviewRecord(
  videoKey: VideoKey,
  snapshot: NoteSnapshot,
  analysis: Fields,
  failures: unknown,
  updatedAt: number,
): OverviewRecord {
  const analysisFailures = normalizeAnalysisFailures(failures);
  return {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey,
    snapshot,
    analysis: checkAnalysis(analysis),
    ...(analysisFailures.length ? { analysisFailures } : {}),
    updatedAt,
  };
}

export function checkOverview(value: unknown): OverviewRecord | null {
  if (!isFields(value)) return null;
  const videoKey = videoOf(value.videoKey);
  const updatedAt = finite(value.updatedAt);
  const { snapshot, analysis } = value;
  if (!videoKey || updatedAt === null || !isFields(analysis)) return null;
  return overviewRecord(videoKey, storedSnapshot(snapshot), analysis, value.analysisFailures, updatedAt);
}

function citationsOf(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.flatMap((item) => {
    if (!isFields(item)) return [];
    const startSeconds = finite(item.startSeconds);
    if (startSeconds === null || startSeconds < 0 || typeof item.quote !== "string") return [];
    return [{ startSeconds, quote: item.quote }];
  });
}

function secondsOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.filter((item): item is number => finite(item) !== null && Number(item) >= 0);
}

/** 问答的公共部分：问题和回答必须是文字，引用和可点的时间点只留认得的。 */
export function qaRecord(id: string, video: VideoKey, fields: Fields, derived: Derived | undefined): QaRecord | null {
  const { question, answer } = fields;
  if (typeof question !== "string" || typeof answer !== "string") return null;
  return {
    id,
    video,
    question,
    answer,
    citations: citationsOf(fields.citations),
    clickable: secondsOf(fields.clickable),
    ...(fields.truncated === true ? { truncated: true as const } : {}),
    ...(derived === undefined ? {} : { derived }),
    createdAt: finite(fields.createdAt) ?? 0,
  };
}

export function checkQa(value: unknown): QaRecord | null {
  if (!isFields(value) || !isQaId(value.id)) return null;
  const video = videoOf(value.video);
  if (!video) return null;
  return qaRecord(value.id, video, value, value.derived === undefined ? undefined : checkDerived(value.derived));
}
