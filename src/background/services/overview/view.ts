// 交给页面和卡片的概览：只有生效中的章节、金句、结论和失败区间，加上各部分依据的字幕指纹。重新生成写到一半的草稿和其余来历都不给。
import { hasAnalysisContent } from "../../../core/ai/verdict.ts";
import { normalizeAnalysisFailures, overviewTranscriptBasis, type OverviewRecord } from "../../../core/notes/records.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import type { OverviewResultView } from "../../../shared/messages/overview.ts";
import type { OverviewView } from "../../../shared/messages/transcript.ts";

/** 生效中的那份；章节、金句、结论都没有时不给（只有草稿的也一样）。 */
export function overviewView(record: OverviewRecord | null): OverviewView | undefined {
  if (!record) return undefined;
  const { analysis } = record;
  const verdict = typeof analysis.verdict?.summary === "string" && analysis.verdict.summary.trim() !== "";
  if (!hasAnalysisContent(analysis) && !verdict) return undefined;
  const transcriptBasis = overviewTranscriptBasis(record.parts);
  return { analysis, analysisFailures: normalizeAnalysisFailures(record.analysisFailures), ...(transcriptBasis ? { transcriptBasis } : {}) };
}

/** 本机存着、直接交回去的那份：照实带上失败区间和依据的字幕指纹。 */
export function storedView(video: VideoKey, record: OverviewRecord): OverviewResultView {
  const failures = normalizeAnalysisFailures(record.analysisFailures);
  const transcriptBasis = overviewTranscriptBasis(record.parts);
  return { video, analysis: record.analysis, analysisFailures: failures, ...(transcriptBasis ? { transcriptBasis } : {}), fromCache: true, failedChunks: failures.length };
}
