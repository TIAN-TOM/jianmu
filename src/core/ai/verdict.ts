// 一句话结论：判断档位、给模型的输入和结果校验。
import { formatTimestamp } from "../transcript/segment.ts";

// 一句话结论的判断档位，界面按它们配色，导出也原样写出。
// 「信息不足」留给概览缺块、或已有内容判断不了的情况，不逼模型硬选一档。
export const VERDICT_LABELS: readonly string[] = Object.freeze([
  "值得看完整视频",
  "看概览就够",
  "可以跳过",
  "信息不足",
]);

/** 概览的失败区间，这里只看起止秒数。 */
export interface CoverageGap {
  readonly index?: unknown;
  readonly startSeconds?: unknown;
  readonly endSeconds?: unknown;
  readonly reason?: unknown;
}

export interface VerdictInputs {
  chaptersText: string;
  quotesText: string;
  coverageNote: string;
}

/**
 * 告诉结论模型这份概览覆盖了多少：缺块时逐段列出缺失的时间段。
 * 放在用户提示词里而不是系统提示词：系统提示词要全静态才能命中前缀缓存，
 * 逐次变化的缺块信息只能放在用户提示词里。
 */
function describeCoverage(failures: readonly (CoverageGap | null | undefined)[] | null | undefined): string {
  const list: readonly (CoverageGap | null | undefined)[] = Array.isArray(failures) ? failures : [];
  const ranges = list.filter((range): range is CoverageGap => Boolean(range) && typeof range === "object");
  if (!ranges.length) return "章节摘要和金句覆盖了全片。";
  const spans = ranges
    .map((range) => {
      const start = Math.max(0, Math.floor(Number(range.startSeconds) || 0));
      const end = Math.max(start, Math.floor(Number(range.endSeconds) || start));
      return `${formatTimestamp(start)}–${formatTimestamp(end)}`;
    })
    .join("、");
  return `不完整。以下时间段生成失败，章节摘要和金句里没有这几段的内容：${spans}。`;
}

interface VerdictChapter {
  readonly timestamp?: string;
  readonly title?: string;
  readonly summary?: string;
}

interface VerdictQuote {
  readonly timestamp?: string;
  readonly quote?: string;
}

export interface VerdictAnalysis {
  readonly chapters?: readonly (VerdictChapter | null | undefined)[];
  readonly keyQuotes?: readonly (VerdictQuote | null | undefined)[];
}

/**
 * 把合并好的概览压成结论提示词要的纯文本：每章一行、每条金句一行，
 * 外加覆盖情况（failures 是概览的失败区间）。
 */
export function verdictInputs(
  analysis: VerdictAnalysis | null | undefined,
  { failures = [] }: { readonly failures?: readonly (CoverageGap | null | undefined)[] | null } = {},
): VerdictInputs {
  const chapters: NonNullable<VerdictAnalysis["chapters"]> = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
  const quotes: NonNullable<VerdictAnalysis["keyQuotes"]> = Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [];
  const chaptersText = chapters
    .map((chapter) => {
      const summary = String(chapter?.summary || "").trim();
      return `[${chapter?.timestamp || ""}] ${String(chapter?.title || "").trim()}${summary ? `：${summary}` : ""}`;
    })
    .join("\n");
  const quotesText = quotes
    .map((quote) => `[${quote?.timestamp || ""}] ${String(quote?.quote || "").trim()}`)
    .join("\n");
  return {
    chaptersText,
    quotesText: quotesText || "（无）",
    coverageNote: describeCoverage(failures),
  };
}

/**
 * 概览里有没有模型生成的章节或金句。只用 B站官方总结写过结论时，
 * 概览只有一条结论、章节和金句都是空的，不能当成「已经有概览」。
 */
export function hasAnalysisContent(analysis: unknown): boolean {
  if (!analysis || typeof analysis !== "object") return false;
  const { chapters, keyQuotes } = analysis as { readonly chapters?: unknown; readonly keyQuotes?: unknown };
  return Boolean(
    (Array.isArray(chapters) && chapters.length) ||
      (Array.isArray(keyQuotes) && keyQuotes.length),
  );
}

interface OfficialPoint {
  readonly content?: unknown;
}

interface OfficialPart {
  readonly title?: unknown;
  readonly timestamp?: unknown;
  readonly points?: unknown;
}

export interface OfficialSummary {
  readonly status?: unknown;
  readonly summary?: unknown;
  readonly outline?: unknown;
}

// 有没有内容看内容本身，不看 status。
export function hasOfficialSummaryContent(officialSummary: OfficialSummary | null | undefined): boolean {
  if (!officialSummary || typeof officialSummary !== "object") return false;
  return Boolean(
    String(officialSummary.summary || "").trim() ||
      (Array.isArray(officialSummary.outline) && officialSummary.outline.length),
  );
}

/**
 * 用 B站官方总结写结论时的输入：全片摘要放第一行，官方提纲每段一行当章节，
 * 格式和 verdictInputs 一样是「[时间戳] 标题：要点；要点」。官方总结没有金句。
 * 覆盖情况写明这是 B站对全片的归纳，放在用户提示词里。
 */
export function officialVerdictInputs(officialSummary: OfficialSummary | null | undefined): VerdictInputs {
  const summary = String(officialSummary?.summary || "").trim();
  const rawOutline = officialSummary?.outline;
  const outline: readonly (OfficialPart | null | undefined)[] = Array.isArray(rawOutline) ? rawOutline : [];
  const lines = summary ? [`全片概述：${summary}`] : [];
  for (const part of outline) {
    const title = String(part?.title || "").trim();
    const rawPoints = part?.points;
    const pointList: readonly (OfficialPoint | null | undefined)[] = Array.isArray(rawPoints) ? rawPoints : [];
    const points = pointList
      .map((point) => String(point?.content || "").trim())
      .filter(Boolean);
    if (!title && !points.length) continue;
    // null 用 Number 会变成 0，没有时间戳的段落不能标成片头。
    const raw = part?.timestamp;
    const seconds = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    const stamp = Number.isFinite(seconds) && seconds >= 0 ? `[${formatTimestamp(seconds)}] ` : "";
    lines.push(`${stamp}${title || "（这一段没有标题）"}${points.length ? `：${points.join("；")}` : ""}`);
  }
  return {
    chaptersText: lines.join("\n"),
    quotesText: "（无）",
    coverageNote:
      "覆盖全片。章节摘要取自 B站官方 AI 总结的提纲，是 B站对全片的归纳，不是逐字字幕；没有金句。",
  };
}

export interface Verdict {
  summary: string;
  value: string;
  verdict: string;
  reason: string;
  incomplete?: true;
}

/**
 * 结论同样当不可信数据处理：没有 summary 就当没生成；判断不在几档里就不显示，
 * 免得模型自创一档「还行」。字段按提示词的字数要求留些余量再截断。
 * incomplete：概览有失败块，结论只基于部分内容，界面和导出都要标出来。
 */
export function validateVerdict(
  parsed: unknown,
  { incomplete = false }: { readonly incomplete?: boolean } = {},
): Verdict | null {
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as {
    readonly summary?: unknown;
    readonly value?: unknown;
    readonly verdict?: unknown;
    readonly reason?: unknown;
  };
  const clip = (value: unknown, max: number): string => String(value || "").trim().slice(0, max);
  const summary = clip(source.summary, 200);
  if (!summary) return null;
  const verdict = VERDICT_LABELS.includes(String(source.verdict || "").trim())
    ? String(source.verdict).trim()
    : "";
  return {
    summary,
    value: clip(source.value, 120),
    verdict,
    reason: verdict ? clip(source.reason, 120) : "",
    ...(incomplete ? { incomplete: true as const } : {}),
  };
}
