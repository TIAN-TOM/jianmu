// 笔记和概览的记录类型，以及派生结果记下的依据和生成配置。
import type { ChapterPart, FailureRange, QuotePart, StoredRange } from "../ai/chunking.ts";
import type { Effort } from "../ai/effort-level.ts";
import { OUTPUT_LANGS, type OutputLang } from "../output-lang.ts";
import type { CaptionKind } from "../transcript/sources.ts";
import { parseVideoKey, type VideoKey } from "../video-ref.ts";

/** 一个字幕版本：真实视频、来源、语言和正文指纹。 */
export interface TranscriptRef {
  readonly video: VideoKey;
  readonly kind: CaptionKind;
  readonly lang: string;
  readonly fingerprint: string;
}

/** 结果依据的是什么。依据对得上才复用，对不上的标成基于旧内容。 */
export type Basis =
  | { readonly source: "transcript"; readonly transcript: TranscriptRef }
  | { readonly source: "official-summary"; readonly video: VideoKey; readonly fingerprint: string }
  | { readonly source: "title-description"; readonly video: VideoKey; readonly fingerprint: string }
  | { readonly source: "legacy-unknown"; readonly hint?: "official-summary" };

// 和传输层请求里的 feature 是同一个值。
export type FeatureId = string;

/** 任务创建时取定的生成配置，effort 是实际生效的档位。 */
export interface GenInfo {
  readonly feature: FeatureId;
  readonly promptVersion: string;
  readonly model: string;
  readonly effort: Effort;
  /** 模型写这份结果用的语言。旧记录没有这一项，按简体（core/output-lang.ts 的 outputLangOf）。 */
  readonly outputLang?: OutputLang;
}

type LegacyBasis = Extract<Basis, { readonly source: "legacy-unknown" }>;

/** 结果记下的依据和生成配置。旧备份导入的记录不知道当时的生成配置，只有依据未知的可以缺 gen。 */
export type Derived =
  | { readonly basis: Exclude<Basis, LegacyBasis>; readonly gen: GenInfo }
  | { readonly basis: LegacyBasis; readonly gen?: GenInfo };

export type NoteKind = "note";

// user 是用户在扩展里存下的，legacy 是从旧备份导入的。
export type NoteOrigin = "user" | "legacy";

/** 快照里标题和作者存下的最大长度，超出的截掉。 */
export const TITLE_MAX = 500;
export const AUTHOR_MAX = 300;

/** 存笔记时的视频和频道信息，视频改名后笔记照样能显示。 */
export interface NoteSnapshot {
  readonly title: string;
  readonly author: string;
  readonly channel?: string;
}

export interface NoteRecord {
  readonly id: string;
  readonly kind: NoteKind;
  readonly origin: NoteOrigin;
  readonly video: VideoKey;
  readonly snapshot: NoteSnapshot;
  readonly atSec: number;
  readonly text: string;
  readonly quote?: string;
  readonly derived?: Derived;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 问答引用的一句：原句是存下时从字幕里取的快照，字幕换了也照样显示。 */
export interface QaCitation {
  readonly startSeconds: number;
  readonly quote: string;
}

/** 一条问答，记下后不改。依据是回答时读到的那份字幕。 */
export interface QaRecord {
  readonly id: string;
  readonly video: VideoKey;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly QaCitation[];
  /** 回答正文里哪些时间点落在送给模型的范围内，可以点。 */
  readonly clickable: readonly number[];
  /** 回答由被截断的正文补齐得到，可能只有半截。 */
  readonly truncated?: true;
  readonly derived: Derived;
  readonly createdAt: number;
}

export const OVERVIEW_RECORD_VERSION = 1;

/** 概览里的结论。存下来的和备份读进来的都可能缺项或类型不对，读的时候各自校验。 */
export interface LearningVerdict {
  readonly summary?: unknown;
  readonly value?: unknown;
  readonly verdict?: unknown;
  readonly reason?: unknown;
  readonly source?: unknown;
  readonly incomplete?: unknown;
  /** 重点章节的起始秒，只认和现有章节对得上的。 */
  readonly keyStarts?: unknown;
  /** 模型的正文被截断，靠补齐读出来：摘要或理由可能只有半句。 */
  readonly truncated?: unknown;
  /** 视频标题译成结论语言的样子，只有侧边栏顶上的标题用；导出照旧用原标题。 */
  readonly translatedTitle?: unknown;
}

/** 概览的正文：章节、关键句和结论。 */
export interface LearningAnalysis {
  readonly chapters?: readonly ChapterPart[] | null;
  readonly keyQuotes?: readonly QuotePart[] | null;
  readonly verdict?: LearningVerdict | null;
}

/** 概览的一部分（章节、结论）是哪个任务写的、依据什么、用什么配置生成的。 */
export interface OverviewPart {
  readonly derived: Derived;
  /** 写它的任务的创建时间：较早创建的任务不覆盖较晚的。 */
  readonly taskCreatedAt: number;
}

/** 生效中的章节和结论各自的来历。旧版本存下的、导入的旧备份里的记录没有。 */
export interface OverviewParts {
  readonly chapters?: OverviewPart;
  readonly verdict?: OverviewPart;
}

/** 结果依据的那份字幕的指纹；依据不是字幕的（官方总结、标题和简介、旧版未知）没有。 */
export function transcriptFingerprintOf(derived: Derived | undefined): string | undefined {
  const basis = derived?.basis;
  return basis?.source === "transcript" && basis.transcript.fingerprint !== "" ? basis.transcript.fingerprint : undefined;
}

/** 概览里依据字幕写的章节和结论，各自依据的字幕指纹。 */
export interface OverviewTranscriptBasis {
  readonly chapters?: string;
  readonly verdict?: string;
}

export function overviewTranscriptBasis(parts: OverviewParts | undefined): OverviewTranscriptBasis | undefined {
  const chapters = transcriptFingerprintOf(parts?.chapters?.derived);
  const verdict = transcriptFingerprintOf(parts?.verdict?.derived);
  if (!chapters && !verdict) return undefined;
  return { ...(chapters ? { chapters } : {}), ...(verdict ? { verdict } : {}) };
}

/** 依据的字幕和现在用的不是同一份，标「基于旧字幕」。哪一边不知道都不标。 */
export function onOldTranscript(basedOn: string | undefined, current: string | null | undefined): boolean {
  return Boolean(basedOn) && Boolean(current) && basedOn !== current;
}

/** 重新生成已有的概览时先写在这里，结论写好才换上；停在中途或结论没写成时，生效的那份不动。 */
export interface OverviewDraft {
  readonly analysis: LearningAnalysis;
  readonly analysisFailures?: readonly FailureRange[];
  readonly chapters: OverviewPart;
}

/** 一个视频的概览，不随字幕缓存过期。analysis 和 analysisFailures 是生效中的那份。 */
export interface OverviewRecord {
  readonly schemaVersion: number;
  readonly videoKey: VideoKey;
  readonly snapshot: NoteSnapshot;
  readonly analysis: LearningAnalysis;
  readonly analysisFailures?: readonly FailureRange[];
  readonly parts?: OverviewParts;
  readonly draft?: OverviewDraft;
  readonly updatedAt: number;
}

// 导出和过滤读到的笔记来自存储或用户选的文件，字段可能缺失，读的时候都按宽容处理。
export type NoteFields = Partial<NoteRecord>;

export type NoteList<T extends NoteFields = NoteFields> = readonly (T | null | undefined)[] | null | undefined;

export function noteList<T extends NoteFields>(notes: NoteList<T>): T[] {
  const source: readonly (T | null | undefined)[] = Array.isArray(notes) ? notes : [];
  return source.filter((note): note is T => Boolean(note) && typeof note === "object");
}

// 标题和搜索用站点自己的视频编号；键认不出时原样用键。
export function videoIdOf(video: string | null | undefined): string {
  const key = String(video || "");
  return parseVideoKey(key)?.videoId ?? key;
}

// 失败原因给人看，一句话足够；和分块记失败原因时的截断长度一致。
const FAILURE_REASON_MAX = 200;

interface StoredFailure extends StoredRange {
  readonly reason?: unknown;
}

/** 概览的失败区间：原因跟着区间长期保存，字段缺失或类型不对时补成能用的值。 */
export function normalizeAnalysisFailures(value: unknown): FailureRange[] {
  if (!Array.isArray(value)) return [];
  const items: readonly (StoredFailure | null | undefined)[] = value;
  return items
    .map((item) => {
      const startSeconds = Math.max(0, Math.floor(Number(item?.startSeconds) || 0));
      const endSeconds = Math.max(startSeconds, Math.floor(Number(item?.endSeconds) || startSeconds));
      const reason = typeof item?.reason === "string" ? item.reason.trim().slice(0, FAILURE_REASON_MAX) : "";
      return {
        index: Math.max(0, Math.floor(Number(item?.index) || 0)),
        startSeconds,
        endSeconds,
        ...(reason ? { reason } : {}),
      };
    })
    .filter((item) => Number.isFinite(item.startSeconds));
}

/** 按字幕版本存在本机的几种文字：三种译文，加整理后的原文（tidy）。 */
export type TextTarget = OutputLang | "tidy";

/** 按字幕版本存的译文和整理后的字幕：一版字幕译成一种语言（或整理一遍）是一条，记录里按段的原文指纹记文字。 */
export interface TranslationRecord {
  readonly id: string;
  readonly video: VideoKey;
  readonly transcript: TranscriptRef;
  readonly target: TextTarget;
  /** 按段的原文认：换了字幕版本，原文没变的段还对得上。 */
  readonly segments: Readonly<Record<string, string>>;
  readonly derived: Derived;
  readonly updatedAt: number;
}

export const TEXT_TARGETS: readonly TextTarget[] = Object.freeze([...OUTPUT_LANGS, "tidy"]);

export const translationId = (transcript: Pick<TranscriptRef, "video" | "fingerprint">, target: TextTarget): string => `${transcript.video}|${transcript.fingerprint}|${target}`;
