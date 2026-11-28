// 一句话结论：观看星级、给模型的输入和结果校验。
import { inLang, type OutputLang } from "../output-lang.ts";
import { storedCommentView, type CommentView } from "./comments.ts";
import { LEGACY_RATINGS_HANT, VERDICT_HANT } from "./verdict-hant.ts";
import { formatTimestamp, startSecondsOf } from "../transcript/segment.ts";

export const VERDICT_STARS = Object.freeze([5, 4, 3, 2, 1] as const);
export type VerdictStars = (typeof VERDICT_STARS)[number];
export type VerdictRating = VerdictStars | "信息不足";

function modelRating(raw: unknown): VerdictRating | "" {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (value === "信息不足" || value === VERDICT_HANT.unknown) return "信息不足";
  return VERDICT_STARS.find((stars) => value === stars || value === String(stars)) ?? "";
}

const LEGACY_RATINGS: Readonly<Record<string, VerdictRating>> = {
  推荐看: 5,
  可以看: 3,
  可跳过: 1,
  信息不足: "信息不足",
  值得看完整视频: 5,
  可以跳过: 1,
  看概览就够: 2,
  ...LEGACY_RATINGS_HANT,
  [VERDICT_HANT.unknown]: "信息不足",
};

/** 读旧结论时换算星数，存储里的旧值保留原样。 */
export function verdictLabelOf(raw: unknown): VerdictRating | "" {
  if (typeof raw !== "string") return modelRating(raw);
  const label = raw.trim();
  return Object.hasOwn(LEGACY_RATINGS, label) ? LEGACY_RATINGS[label] ?? "" : "";
}

const VERDICT_ZH = { 5: "推荐看", 4: "值得看", 3: "挑着看", 2: "可略过", 1: "可跳过", unknown: "信息不足" };
const VERDICT_EN = { 5: "Must watch", 4: "Worth watching", 3: "Watch the key parts", 2: "Mostly skippable", 1: "Skip", unknown: "Not enough info" };

/** 页面和导出共用的星级短词。 */
export function verdictName(raw: unknown, lang: OutputLang): string {
  const rating = verdictLabelOf(raw);
  if (!rating) return "";
  const names = inLang(lang, VERDICT_ZH, VERDICT_EN, VERDICT_HANT);
  return names[rating === "信息不足" ? "unknown" : rating];
}

/** 写进 Markdown 的星级和短词。 */
export function verdictText(raw: unknown, lang: OutputLang): string {
  const rating = verdictLabelOf(raw);
  const name = verdictName(rating, lang);
  return typeof rating === "number" ? `${"★".repeat(rating)}${"☆".repeat(5 - rating)} ${name}` : name;
}

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
  verdict: VerdictRating | "";
  reason: string;
  /** 重点章节的起始秒，按时间先后；一个都没有时不写这个字段。 */
  keyStarts?: number[];
  /** 视频标题译成结论语言的样子；标题本来就是这种语言、或者译名不合格时不写这个字段。 */
  translatedTitle?: string;
  incomplete?: true;
  /** 评论区怎么说（PRD F23）：只在构建开关 FEATURE_COMMENTS 打开、这次读到了评论时有。 */
  comments?: CommentView;
}

/** 重点章节最多几个。 */
export const KEY_CHAPTERS_MAX = 3;

/**
 * 重点章节的本机校验：每一项规范成整秒，和现有章节的起始秒精确对上才留；
 * 去重，最多三个，允许第 0 秒，按时间先后排。缺字段、格式错、对不上的只是丢掉，不连累结论。
 * 超过三个时留模型先给的那几个。
 */
export function validKeyStarts(raw: unknown, chapterStarts: readonly unknown[] | null | undefined): number[] {
  if (!Array.isArray(raw)) return [];
  const items: readonly unknown[] = raw;
  const known = new Set(
    (Array.isArray(chapterStarts) ? chapterStarts : [])
      .map((start) => startSecondsOf(start))
      .filter((start): start is number => start !== null),
  );
  const kept: number[] = [];
  for (const item of items) {
    if (kept.length >= KEY_CHAPTERS_MAX) break;
    const start = startSecondsOf(item);
    if (start === null || !known.has(start) || kept.includes(start)) continue;
    kept.push(start);
  }
  return kept.sort((a, b) => a - b);
}

interface KeyedAnalysis {
  readonly chapters?: readonly ({ readonly timestampSeconds?: unknown } | null | undefined)[] | null;
  readonly verdict?: { readonly keyStarts?: unknown } | null;
}

/**
 * 交给页面标重点用：结论里记着的重点再和当前章节核对一遍。
 * 章节被重新生成过、结论还是旧的时，对不上的那几个不标。
 */
export function keyChapterStarts(analysis: KeyedAnalysis | null | undefined): number[] {
  const chapters = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
  return validKeyStarts(analysis?.verdict?.keyStarts, chapters.map((chapter) => chapter?.timestampSeconds));
}

const withKeys = (keyStarts: number[]): { keyStarts?: number[] } => (keyStarts.length ? { keyStarts } : {});

/** 译名最长多少字符。B 站标题八十字、YouTube 一百字，译成英文也到不了这么长，超过的多半是模型写跑了。 */
export const TRANSLATED_TITLE_MAX = 300;

const sameTitle = (a: string, b: string): boolean => a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();

/**
 * 结论里带的标题译名：去掉首尾空白；空的、超过上限的不算，整个丢掉不截断。
 * 给了原标题时，和原标题一样的（不计大小写和空白）、原标题本身是空的也不算。
 * 读存着的结论时不给原标题，写的时候已经比过了。不合格时交回空串，不连累结论的其他部分。
 */
export function translatedTitleOf(raw: unknown, title?: string): string {
  if (typeof raw !== "string") return "";
  const translated = raw.trim();
  if (!translated || translated.length > TRANSLATED_TITLE_MAX) return "";
  if (title === undefined) return translated;
  const original = title.trim();
  return original && !sameTitle(translated, original) ? translated : "";
}

const withTitle = (translatedTitle: string): { translatedTitle?: string } => (translatedTitle ? { translatedTitle } : {});

export interface VerdictCheck {
  /** 概览有失败块，结论只基于部分内容，界面和导出都要标出来。 */
  readonly incomplete?: boolean;
  /** 读存着的结论（本机记录、备份）：旧档位按 verdictLabelOf 换算成星。 */
  readonly stored?: boolean;
  /** 写结论时看到的章节的起始秒。不给时不收重点章节。 */
  readonly chapterStarts?: readonly unknown[] | undefined;
  /** 结论的语言，截断上限按它取。 */
  readonly lang: OutputLang;
  /** 发给模型的原标题，标题译名要和它比；读存着的结论时不给。 */
  readonly title?: string | undefined;
}

/**
 * 各字段按字符截断的上限，比提示词要求的长度留出余量。简体、繁体按提示词的 80 字、50 字算；
 * 英文按 50 词、30 词算，一个词连空格六七个字符，同样留一倍多的余量，免得截成半句。
 */
export const VERDICT_CLIP: Readonly<Record<OutputLang, { readonly summary: number; readonly value: number; readonly reason: number }>> = Object.freeze({
  zh: Object.freeze({ summary: 200, value: 120, reason: 120 }),
  "zh-Hant": Object.freeze({ summary: 200, value: 120, reason: 120 }),
  en: Object.freeze({ summary: 800, value: 480, reason: 480 }),
});

/**
 * 结论同样当不可信数据处理：没有 summary 就当没生成；判断不符合约定时只丢掉判断和理由。字段按提示词的字数要求留些余量再截断。
 * 重点章节（模型输出里的 keyChapters）按 validKeyStarts 过滤，坏了只丢重点；标题译名按 translatedTitleOf 收，坏了只丢译名。
 */
export function validateVerdict(
  parsed: unknown,
  { incomplete = false, stored = false, chapterStarts, lang, title }: VerdictCheck,
): Verdict | null {
  if (!parsed || typeof parsed !== "object") return null;
  const source = parsed as {
    readonly summary?: unknown;
    readonly value?: unknown;
    readonly verdict?: unknown;
    readonly reason?: unknown;
    readonly keyChapters?: unknown;
    readonly translatedTitle?: unknown;
    readonly comments?: unknown;
  };
  const clip = (value: unknown, max: number): string => String(value || "").trim().slice(0, max);
  const limits = VERDICT_CLIP[lang];
  const summary = clip(source.summary, limits.summary);
  if (!summary) return null;
  const verdict = stored ? verdictLabelOf(source.verdict) : modelRating(source.verdict);
  return {
    summary,
    value: clip(source.value, limits.value),
    verdict,
    reason: verdict ? clip(source.reason, limits.reason) : "",
    ...withKeys(chapterStarts ? validKeyStarts(source.keyChapters, chapterStarts) : []),
    ...withTitle(translatedTitleOf(source.translatedTitle, title)),
    ...(incomplete ? { incomplete: true as const } : {}),
    // 存着的评论区那一块照形状核一遍留下；模型新写的由调用方按发出去的那批评论另外核对后加上。
    ...(FEATURE_COMMENTS && stored ? withComments(storedCommentView(source.comments)) : {}),
  };
}

const withComments = (comments: CommentView | null): { comments?: CommentView } => (comments ? { comments } : {});
