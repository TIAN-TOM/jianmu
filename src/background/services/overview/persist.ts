// 概览落库：章节和结论按部分写，各记依据、生成配置和写它的任务的创建时间，较早创建的任务不覆盖较晚的。
// 第一次生成直接写生效的那份；重新生成已有的概览先写草稿，结论写好才换上，停在中途或结论没写成时生效的那份不动。
// 用官方总结写的结论只占结论这一部分，依据字幕写的结论不让它覆盖。
// 走到落库这一步时分块都已经付过费：存不下（空间不足、事务中止）不抛错，标出没存上，结果照样交回。
// 写入经仓储的清除闸门，等模型的工夫清除了本机数据就不写，按取消收尾。
import type { FailureRange } from "../../../core/ai/chunking.ts";
import type { ClearEpoch } from "../../../core/clear-guard.ts";
import type { LearningAnalysis, LearningVerdict } from "../../../core/notes/markdown.ts";
import { normalizeAnalysisFailures, OVERVIEW_RECORD_VERSION, type OverviewPart, type OverviewRecord } from "../../../core/notes/records.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewChange, OverviewStore } from "../../stores/overviews.ts";

const TITLE_MAX = 500;
const AUTHOR_MAX = 300;

/** 清除过本机数据：这次不写，调用方按取消收尾。 */
export const CLEARED = Symbol("cleared");

export interface Saved {
  /** 生效中的那份：写进去的，没写成时是打算写的。 */
  readonly analysis: LearningAnalysis;
  readonly analysisFailures: readonly FailureRange[];
  readonly saveFailed?: true;
  /** 更晚创建的任务已经写了这一部分，这次没写。 */
  readonly superseded?: true;
}

export interface PersistDeps {
  readonly overviews: Pick<OverviewStore, "updateRecord">;
  readonly now: () => number;
  readonly log: Log;
}

export interface SnapshotFields {
  readonly video: VideoKey;
  readonly title: string;
  readonly author: string;
}

export interface ChapterWrite {
  /** 章节、金句和截断区间；结论由结论那一步单独写。 */
  readonly analysis: LearningAnalysis;
  readonly failures: readonly FailureRange[];
  readonly part: OverviewPart;
}

const newer = (existing: OverviewPart | undefined, mine: OverviewPart): boolean =>
  existing !== undefined && existing.taskCreatedAt > mine.taskCreatedAt;

// 旧备份导入的结论依据未知，没标过依据官方总结的按依据字幕算，免得被只依据官方总结的盖掉。
function isTranscriptBased(part: OverviewPart | undefined): boolean {
  const basis = part?.derived.basis;
  return basis?.source === "transcript" || (basis?.source === "legacy-unknown" && basis.hint !== "official-summary");
}

/**
 * 结论这一部分谁留下：依据字幕写的优先于只依据官方总结的；同一类的，较晚创建的任务赢。
 * 旧记录没写来历的，当作谁都能换掉。
 */
export function verdictWins(existing: OverviewPart | undefined, incoming: OverviewPart): boolean {
  if (!existing) return true;
  if (isTranscriptBased(incoming) !== isTranscriptBased(existing)) return isTranscriptBased(incoming);
  return !newer(existing, incoming);
}

const withoutVerdict = ({ verdict: _verdict, ...rest }: LearningAnalysis): LearningAnalysis => rest;

function failuresOf(failures: readonly FailureRange[]): { readonly analysisFailures?: FailureRange[] } {
  const list = normalizeAnalysisFailures(failures);
  return list.length ? { analysisFailures: list } : {};
}

function blank(fields: SnapshotFields, now: number): OverviewRecord {
  return {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey: fields.video,
    snapshot: { title: fields.title.slice(0, TITLE_MAX), author: fields.author.slice(0, AUTHOR_MAX) },
    analysis: {},
    updatedAt: now,
  };
}

const effectiveOf = (record: OverviewRecord | null | undefined): Saved => ({
  analysis: record?.analysis ?? {},
  analysisFailures: normalizeAnalysisFailures(record?.analysisFailures),
});

function withoutField<K extends keyof OverviewRecord>(record: OverviewRecord, key: K): OverviewRecord {
  const { [key]: _dropped, ...rest } = record;
  return rest as OverviewRecord;
}

/** 生效的章节：更晚的任务写过就不动；已有的结论先留着，等这次的结论写好再换。比这次早的草稿作废。 */
export function planChapters(current: OverviewRecord | null, fields: SnapshotFields, write: ChapterWrite, now: number): OverviewRecord | null {
  if (current && newer(current.parts?.chapters, write.part)) return null;
  const base = current ?? blank(fields, now);
  const verdict = base.analysis.verdict;
  const record: OverviewRecord = {
    ...withoutField(withoutField(base, "analysisFailures"), "draft"),
    analysis: { ...withoutVerdict(write.analysis), ...(verdict ? { verdict } : {}) },
    ...failuresOf(write.failures),
    parts: { ...base.parts, chapters: write.part },
    ...(base.draft && newer(base.draft.chapters, write.part) ? { draft: base.draft } : {}),
    updatedAt: now,
  };
  return record;
}

/** 重新生成的章节写成草稿，生效的那份不动。更晚的任务写过章节或草稿就不写。 */
export function planDraft(current: OverviewRecord | null, write: ChapterWrite): OverviewRecord | null {
  if (!current) return null;
  if (newer(current.parts?.chapters, write.part) || newer(current.draft?.chapters, write.part)) return null;
  const draft = { analysis: withoutVerdict(write.analysis), ...failuresOf(write.failures), chapters: write.part };
  return { ...current, draft };
}

export interface VerdictWrite {
  readonly verdict: LearningVerdict;
  readonly part: OverviewPart;
  /** 这次的章节是哪个任务写的：生效的章节或草稿不再是它写的那份，结论就不往上放。 */
  readonly chaptersCreatedAt: number;
  /** 这次的章节写在草稿里：结论写好连同草稿一起换上。 */
  readonly fromDraft: boolean;
}

/** 结论写进去：草稿那份一起换上；直接写的只在生效的章节还是这次写的那份时放。 */
export function planVerdict(current: OverviewRecord | null, write: VerdictWrite, now: number): OverviewRecord | null {
  if (!current) return null;
  if (write.fromDraft) {
    const draft = current.draft;
    if (!draft || draft.chapters.taskCreatedAt !== write.chaptersCreatedAt || newer(current.parts?.chapters, draft.chapters)) return null;
    const keepVerdict = !verdictWins(current.parts?.verdict, write.part) && current.analysis.verdict;
    const verdictPart = keepVerdict ? current.parts?.verdict : write.part;
    return {
      ...withoutField(withoutField(current, "draft"), "analysisFailures"),
      analysis: { ...draft.analysis, verdict: keepVerdict ? current.analysis.verdict : write.verdict },
      ...failuresOf(draft.analysisFailures ?? []),
      parts: { chapters: draft.chapters, ...(verdictPart ? { verdict: verdictPart } : {}) },
      updatedAt: now,
    };
  }
  const chapters = current.parts?.chapters;
  if (chapters && chapters.taskCreatedAt !== write.chaptersCreatedAt) return null;
  if (!verdictWins(current.parts?.verdict, write.part)) return null;
  return {
    ...current,
    analysis: { ...current.analysis, verdict: write.verdict },
    parts: { ...current.parts, verdict: write.part },
    updatedAt: now,
  };
}

export interface OfficialVerdictWrite {
  readonly verdict: LearningVerdict;
  readonly part: OverviewPart;
}

const hasSummary = (verdict: LearningVerdict | null | undefined): boolean => typeof verdict?.summary === "string" && verdict.summary.trim() !== "";

/**
 * 用官方总结写的结论只占结论这一部分，不碰章节和草稿。还没有记录时新建一条只有结论的；
 * 依据字幕写的结论不让它覆盖，没记来历的旧结论只要不是官方总结写的也一样。
 */
export function planOfficialVerdict(current: OverviewRecord | null, fields: SnapshotFields, write: OfficialVerdictWrite, now: number): OverviewRecord | null {
  if (!current) return { ...blank(fields, now), analysis: { chapters: [], keyQuotes: [], verdict: write.verdict }, parts: { verdict: write.part } };
  const existing = current.analysis.verdict;
  const unrecorded = hasSummary(existing) && !current.parts?.verdict && existing?.source !== "official";
  if (unrecorded || !verdictWins(current.parts?.verdict, write.part)) return null;
  return {
    ...current,
    analysis: { ...current.analysis, verdict: write.verdict },
    parts: { ...current.parts, verdict: write.part },
    updatedAt: now,
  };
}

export interface Persist {
  /** 写生效的章节。 */
  chapters(fields: SnapshotFields, write: ChapterWrite, since: ClearEpoch | undefined): Promise<Saved | typeof CLEARED>;
  /** 写草稿，生效的那份照旧交回。 */
  draft(fields: SnapshotFields, write: ChapterWrite, since: ClearEpoch | undefined): Promise<Saved | typeof CLEARED>;
  /** 写结论；交回写完以后生效的那份。chapters：上一次章节没写进去，这次先把章节（或草稿）补上再放结论。 */
  verdict(fields: SnapshotFields, write: VerdictWrite, intended: Saved, since: ClearEpoch | undefined, chapters?: ChapterWrite): Promise<Saved | typeof CLEARED>;
  /** 写用官方总结写的结论；交回写完以后生效的那份。intended：没存上时交回去的。 */
  official(fields: SnapshotFields, write: OfficialVerdictWrite, intended: Saved, since: ClearEpoch | undefined): Promise<Saved | typeof CLEARED>;
}

export function createPersist({ overviews, now, log }: PersistDeps): Persist {
  // 读—改—写在仓储的写队列里一次做完。plan 交回 null 是不写，交回现有的那份。
  async function apply(
    video: VideoKey,
    plan: (current: OverviewRecord | null) => OverviewRecord | null,
    intended: Saved,
    since: ClearEpoch | undefined,
  ): Promise<Saved | typeof CLEARED> {
    try {
      const outcome = await overviews.updateRecord(
        video,
        (current): OverviewChange<{ readonly record: OverviewRecord | null; readonly wrote: boolean }> => {
          const next = plan(current);
          return next ? { put: [next], result: { record: next, wrote: true } } : { result: { record: current, wrote: false } };
        },
        { since },
      );
      if (!outcome) return CLEARED;
      return outcome.wrote ? effectiveOf(outcome.record) : { ...effectiveOf(outcome.record), superseded: true };
    } catch (error) {
      log.error("概览保存失败", errorLabel(error));
      return { ...intended, saveFailed: true };
    }
  }

  return {
    chapters(fields, write, since) {
      const intended = { analysis: write.analysis, analysisFailures: [...write.failures] };
      return apply(fields.video, (current) => planChapters(current, fields, write, now()), intended, since);
    },

    draft(fields, write, since) {
      const intended = { analysis: write.analysis, analysisFailures: [...write.failures] };
      return apply(fields.video, (current) => planDraft(current, write), intended, since);
    },

    verdict(fields, write, intended, since, chapters) {
      return apply(
        fields.video,
        (current) => {
          const base = chapters ? ((write.fromDraft ? planDraft(current, chapters) : planChapters(current, fields, chapters, now())) ?? current) : current;
          return planVerdict(base, write, now());
        },
        intended,
        since,
      );
    },

    official(fields, write, intended, since) {
      return apply(fields.video, (current) => planOfficialVerdict(current, fields, write, now()), intended, since);
    },
  };
}
