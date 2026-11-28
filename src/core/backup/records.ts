// 备份里四类记录的校验：导出、读新格式、转换旧格式都过这一道。只留记录类型里有的字段，
// 概览过一遍和生成时相同的校验，必填的字段不对就整条丢掉，交给调用方计数。草稿不进备份。
import { isRecord } from "../../shared/guards.ts";
import type { TimeRange } from "../ai/chunking.ts";
import { EFFORTS } from "../ai/effort-level.ts";
import { validateAnalysis } from "../ai/validate.ts";
import { validateVerdict, validKeyStarts } from "../ai/verdict.ts";
import {
  AUTHOR_MAX,
  normalizeAnalysisFailures,
  OVERVIEW_RECORD_VERSION,
  type Basis,
  type Derived,
  type GenInfo,
  type LearningAnalysis,
  type LearningVerdict,
  type NoteRecord,
  type NoteSnapshot,
  type OverviewPart,
  type OverviewParts,
  type OverviewRecord,
  type QaCitation,
  type QaRecord,
  type TranscriptRef,
  type TranslationRecord,
  TEXT_TARGETS,
  TITLE_MAX,
  translationId,
} from "../notes/records.ts";
import { isOutputLang, outputLangOf, type OutputLang } from "../output-lang.ts";
import { CAPTION_KINDS } from "../transcript/sources.ts";
import { parseVideoKey, type VideoKey } from "../video-ref.ts";

export interface BackupContents {
  readonly notes: readonly NoteRecord[];
  readonly overviews: readonly OverviewRecord[];
  readonly qa: readonly QaRecord[];
  readonly translations: readonly TranslationRecord[];
}

export type RecordKind = keyof BackupContents;

export const RECORD_KINDS: readonly RecordKind[] = Object.freeze(["notes", "overviews", "qa", "translations"]);

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

export type Fields = Readonly<Record<string, unknown>>;

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
  return isRecord(value) ? snapshotOf(value.title, value.author, value.channel) : snapshotOf("", "");
}

/** 一份列表逐条过 check：留下认得的，坏的只计数，不拖累同一份里的其他记录。 */
export function keepValid<T>(list: readonly unknown[], check: (value: unknown) => T | null): { kept: T[]; skipped: number } {
  const kept: T[] = [];
  let skipped = 0;
  for (const value of list) {
    let record: T | null;
    try {
      record = check(value);
    } catch {
      // 校验途中抛错的记录（比如字段转不成数字）也只算这一条坏。
      record = null;
    }
    if (record === null) skipped += 1;
    else kept.push(record);
  }
  return { kept, skipped };
}

/** 依据未知：旧备份导入的，和新格式里依据读不懂的。 */
export const UNKNOWN_BASIS: Derived = Object.freeze({ basis: Object.freeze({ source: "legacy-unknown" }) });

function checkGen(value: unknown): GenInfo | null {
  if (!isRecord(value)) return null;
  const { feature, promptVersion, model, effort, outputLang } = value;
  if (typeof feature !== "string" || typeof promptVersion !== "string" || typeof model !== "string") return null;
  if (!oneOf(EFFORTS, effort)) return null;
  // 写内容的语言只认简体、繁体和英文；旧备份没有这一项，认不出的也当没有，读的时候按简体。
  return { feature, promptVersion, model, effort, ...(isOutputLang(outputLang) ? { outputLang } : {}) };
}

function checkBasis(value: unknown): Basis | null {
  if (!isRecord(value)) return null;
  const { source } = value;
  if (source === "transcript") {
    const transcript = value.transcript;
    if (!isRecord(transcript)) return null;
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
  if (!isRecord(value)) return UNKNOWN_BASIS;
  const basis = checkBasis(value.basis);
  const gen = checkGen(value.gen);
  if (!basis) return UNKNOWN_BASIS;
  if (basis.source === "legacy-unknown") return gen ? { basis, gen } : { basis };
  return gen ? { basis, gen } : UNKNOWN_BASIS;
}

/**
 * 结论按生成时的规则重建；依据官方总结写的、正文被截断过的照旧标明。
 * 旧判断换算成星数，保留理由。
 * 重点章节和这条记录的章节对一遍，坏的、对不上的只丢重点；没有这个字段的旧记录按没有重点。
 */
function checkVerdict(value: unknown, chapterStarts: readonly number[], lang: OutputLang): LearningVerdict | null {
  if (!isRecord(value)) return null;
  const verdict = validateVerdict(value, { incomplete: value.incomplete === true, stored: true, lang });
  if (!verdict) return null;
  const keyStarts = validKeyStarts(value.keyStarts, chapterStarts);
  return {
    ...verdict,
    ...(keyStarts.length ? { keyStarts } : {}),
    ...(value.source === "official" ? { source: "official" } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

/** 截断区间：那几段的内容可能不完整，随概览保存。读不懂的区间丢掉。 */
function truncatedRangesOf(value: unknown): TimeRange[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const startSeconds = finite(item.startSeconds);
    const endSeconds = finite(item.endSeconds);
    if (startSeconds === null || endSeconds === null || startSeconds < 0 || endSeconds < startSeconds) return [];
    return [{ startSeconds, endSeconds }];
  });
}

export type CheckedAnalysis = LearningAnalysis & { readonly truncatedRanges?: readonly TimeRange[] };

/** lang 是结论的语言，按结论那部分记下的生成配置；不知道时按简体截。 */
function checkAnalysis(value: Fields, lang: OutputLang): CheckedAnalysis {
  const { chapters, keyQuotes } = validateAnalysis(value, undefined);
  const verdict = checkVerdict(value.verdict, chapters.map((chapter) => chapter.timestampSeconds), lang);
  const truncatedRanges = truncatedRangesOf(value.truncatedRanges);
  return {
    chapters,
    keyQuotes,
    ...(verdict ? { verdict } : {}),
    ...(truncatedRanges.length ? { truncatedRanges } : {}),
  };
}

function checkPart(value: unknown): OverviewPart | null {
  if (!isRecord(value)) return null;
  const taskCreatedAt = finite(value.taskCreatedAt);
  if (taskCreatedAt === null || taskCreatedAt < 0) return null;
  return { derived: checkDerived(value.derived), taskCreatedAt };
}

/** 各部分的来历只跟着还在的那部分走：结论没留下，结论的来历也不留。 */
function checkParts(value: unknown, analysis: LearningAnalysis): OverviewParts | undefined {
  if (!isRecord(value)) return undefined;
  const chapters = checkPart(value.chapters);
  const verdict = analysis.verdict ? checkPart(value.verdict) : null;
  if (!chapters && !verdict) return undefined;
  return { ...(chapters ? { chapters } : {}), ...(verdict ? { verdict } : {}) };
}

export function checkNote(value: unknown): NoteRecord | null {
  if (!isRecord(value)) return null;
  const { id, kind, origin, snapshot, text, quote, derived, updatedAt } = value;
  const video = videoOf(value.video);
  const atSec = finite(value.atSec);
  if (!isRecordId(id) || kind !== "note" || (origin !== "user" && origin !== "legacy")) return null;
  if (!video || atSec === null || atSec < 0 || typeof text !== "string") return null;
  const createdAt = finite(value.createdAt) ?? finite(updatedAt) ?? 0;
  // 正文和原文原样保留：从字幕存的笔记会比手写的上限长，备份不能把存得下的内容截短。
  return {
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
  };
}

/** parts 交回各部分的来历；结论那部分只在结论读得懂时才用。 */
export function overviewRecord(
  videoKey: VideoKey,
  snapshot: NoteSnapshot,
  analysis: Fields,
  failures: unknown,
  updatedAt: number,
  parts: (checked: CheckedAnalysis) => OverviewParts | undefined,
  verdictLang: OutputLang,
): OverviewRecord {
  const analysisFailures = normalizeAnalysisFailures(failures);
  const checked = checkAnalysis(analysis, verdictLang);
  const recorded = parts(checked);
  return {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey,
    snapshot,
    analysis: checked,
    ...(analysisFailures.length ? { analysisFailures } : {}),
    ...(recorded ? { parts: recorded } : {}),
    updatedAt,
  };
}

// 结论那部分记下的语言：先过一遍和导入时相同的来历校验，认不出就按中文。
function verdictLangOf(parts: unknown): OutputLang {
  if (!isRecord(parts) || !isRecord(parts.verdict)) return "zh";
  const derived = checkDerived(parts.verdict.derived);
  return outputLangOf(derived.gen);
}

export function checkOverview(value: unknown): OverviewRecord | null {
  if (!isRecord(value)) return null;
  const videoKey = videoOf(value.videoKey);
  const updatedAt = finite(value.updatedAt);
  const { snapshot, analysis } = value;
  if (!videoKey || updatedAt === null || !isRecord(analysis)) return null;
  return overviewRecord(
    videoKey,
    storedSnapshot(snapshot),
    analysis,
    value.analysisFailures,
    updatedAt,
    (checked) => checkParts(value.parts, checked),
    verdictLangOf(value.parts),
  );
}

function citationsOf(value: unknown): QaCitation[] {
  if (!Array.isArray(value)) return [];
  const items: readonly unknown[] = value;
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
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
export function qaRecord(id: string, video: VideoKey, fields: Fields, derived: Derived): QaRecord | null {
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
    derived,
    createdAt: finite(fields.createdAt) ?? 0,
  };
}

export function checkQa(value: unknown): QaRecord | null {
  if (!isRecord(value) || !isQaId(value.id)) return null;
  const video = videoOf(value.video);
  if (!video) return null;
  return qaRecord(value.id, video, value, checkDerived(value.derived));
}

/** 一版字幕的一段文字最多这么长：远超任何一段字幕，挡住塞进来的大块内容。 */
const TRANSLATED_TEXT_MAX = 20_000;
/** 段的原文指纹最多这么长。 */
const SEGMENT_HASH_MAX = 128;
/** 段的原文指纹是十六进制串：别的键（包括 __proto__ 这类）一律不收。 */
const SEGMENT_HASH = /^[0-9a-f]{8,128}$/;
/** 一条记录最多这么多段，合并以后也不超过。 */
export const SEGMENTS_MAX = 50_000;

function checkTranscriptRef(value: unknown, video: VideoKey): TranscriptRef | null {
  if (!isRecord(value)) return null;
  const { kind, lang, fingerprint } = value;
  if (value.video !== video || !oneOf(CAPTION_KINDS, kind)) return null;
  if (typeof lang !== "string" || lang.length > 40) return null;
  if (typeof fingerprint !== "string" || fingerprint === "" || fingerprint.length > SEGMENT_HASH_MAX) return null;
  return { video, kind, lang, fingerprint };
}

/** 译文或整理后的字幕：主键要和视频、字幕指纹、目标对得上；段里只留非空字符串，坏的段丢掉，一段都不剩就整条丢掉。 */
export function checkTranslation(value: unknown): TranslationRecord | null {
  if (!isRecord(value)) return null;
  const video = videoOf(value.video);
  if (!video || !oneOf(TEXT_TARGETS, value.target)) return null;
  const transcript = checkTranscriptRef(value.transcript, video);
  if (!transcript || value.id !== translationId(transcript, value.target)) return null;
  if (!isRecord(value.segments)) return null;
  const segments: Record<string, string> = {};
  let count = 0;
  for (const [hash, text] of Object.entries(value.segments)) {
    if (count >= SEGMENTS_MAX) break;
    if (!SEGMENT_HASH.test(hash) || typeof text !== "string" || text.trim() === "" || text.length > TRANSLATED_TEXT_MAX) continue;
    segments[hash] = text;
    count += 1;
  }
  if (count === 0) return null;
  const updatedAt = finite(value.updatedAt);
  return {
    id: value.id,
    video,
    transcript,
    target: value.target,
    segments,
    derived: checkDerived(value.derived),
    updatedAt: updatedAt !== null && updatedAt >= 0 ? updatedAt : 0,
  };
}
