// 笔记和概览的记录类型，以及派生结果记下的依据和生成配置。
import type { FailureRange, StoredRange } from "../ai/chunking.ts";
import { parseVideoKey, type VideoKey } from "../video-ref.ts";
import type { LearningAnalysis } from "./markdown.ts";

export type CaptionKind = "human" | "auto" | "official-ai" | "imported";

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

export type Effort = "off" | "low" | "medium" | "high";

/** 任务创建时取定的生成配置，effort 是实际生效的档位。 */
export interface GenInfo {
  readonly feature: FeatureId;
  readonly promptVersion: string;
  readonly model: string;
  readonly effort: Effort;
}

export interface Derived {
  readonly basis: Basis;
  readonly gen: GenInfo;
}

export type NoteKind = "note";

// user 是用户在扩展里存下的，legacy 是从旧备份导入的。
export type NoteOrigin = "user" | "legacy";

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

export const OVERVIEW_RECORD_VERSION = 1;

/** 一个视频的概览，不随字幕缓存过期。 */
export interface OverviewRecord {
  readonly schemaVersion: number;
  readonly videoKey: VideoKey;
  readonly snapshot: NoteSnapshot;
  readonly analysis: LearningAnalysis;
  readonly analysisFailures?: readonly FailureRange[];
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
