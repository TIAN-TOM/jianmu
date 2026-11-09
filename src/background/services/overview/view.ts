// 交给页面和卡片的概览：只有生效中的章节、金句、结论和失败区间。重新生成写到一半的草稿和各部分的来历都不给。
import { hasAnalysisContent } from "../../../core/ai/verdict.ts";
import { normalizeAnalysisFailures, type OverviewRecord } from "../../../core/notes/records.ts";
import type { OverviewView } from "../../../shared/messages/transcript.ts";

/** 生效中的那份；章节、金句、结论都没有时不给（只有草稿的也一样）。 */
export function overviewView(record: OverviewRecord | null): OverviewView | undefined {
  if (!record) return undefined;
  const { analysis } = record;
  const verdict = typeof analysis.verdict?.summary === "string" && analysis.verdict.summary.trim() !== "";
  if (!hasAnalysisContent(analysis) && !verdict) return undefined;
  return { analysis, analysisFailures: normalizeAnalysisFailures(record.analysisFailures) };
}
