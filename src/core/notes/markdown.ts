// 笔记和学习稿的 Markdown 导出。视频地址的前缀由调用方传入，链接只从视频键现拼。
import { groupQuotesIntoChapters, type ChapterPart, type QuotePart } from "../ai/chunking.ts";
import type { OfficialSummary } from "../ai/verdict.ts";
import { formatTimestamp } from "../transcript/segment.ts";
import { parseVideoKey, type VideoKey } from "../video-ref.ts";
import {
  normalizeAnalysisFailures,
  noteList,
  videoIdOf,
  type NoteFields,
  type NoteList,
} from "./records.ts";

export interface NotesExportOptions {
  readonly grouped?: boolean;
}

export interface LearningVerdict {
  readonly summary?: unknown;
  readonly value?: unknown;
  readonly verdict?: unknown;
  readonly reason?: unknown;
  readonly source?: unknown;
  readonly incomplete?: unknown;
}

export interface LearningAnalysis {
  readonly chapters?: readonly ChapterPart[] | null;
  readonly keyQuotes?: readonly QuotePart[] | null;
  readonly verdict?: LearningVerdict | null;
}

/** UP 主给视频划的一段。 */
export interface CreatorChapter {
  readonly start?: unknown;
  readonly title?: unknown;
}

export interface LearningInput {
  readonly title?: string;
  readonly author?: string;
  readonly videoKey?: VideoKey;
  readonly exportedAt?: string | number | Date;
  readonly analysis?: LearningAnalysis | null;
  readonly analysisFailures?: unknown;
  readonly officialSummary?: OfficialSummary | null;
  readonly creatorChapters?: readonly CreatorChapter[] | null;
  readonly notes?: NoteList;
}

interface OutlinePoint {
  readonly content?: unknown;
  readonly timestamp?: unknown;
}

interface OutlinePart {
  readonly title?: unknown;
  readonly timestamp?: unknown;
  readonly points?: unknown;
}

type HrefOf = (seconds: unknown) => string;

// 存着的链接字段不信：备份是用户导进来的文件，那个字段可以是任意网址。
// 前缀加编号的写法只对 B 站成立，别的站和认不出的键不给链接。
function videoHref(video: VideoKey | null | undefined, seconds: unknown, videoBaseUrl: string): string {
  const ref = parseVideoKey(String(video || ""));
  if (ref?.platform !== "bilibili") return "";
  const url = new URL(`${videoBaseUrl}${ref.videoId}`);
  const segment = ref.segment ?? 1;
  if (segment > 1) url.searchParams.set("p", String(segment));
  const start = Math.max(0, Math.floor(Number(seconds) || 0));
  if (start > 0) url.searchParams.set("t", String(start));
  return url.toString();
}

function mdLink(label: string, href: string): string {
  return href ? `[${label}](${href})` : label;
}

/**
 * 写进 Markdown 的外来文字（标题、作者、官方总结、模型输出、笔记）都过一遍：
 * 方括号、尖括号、反引号之类会被当成链接、HTML 和格式，转义成字面量。
 * 这里保留换行，多行文本由调用方续行。
 */
function escapeMarkdown(text: unknown): string {
  return String(text ?? "").replace(/([\\`*_[\]<>])/g, "\\$1");
}

// 多行文本嵌进引用块、列表项时，续行要带上对应前缀，否则第二行会跳出结构。
function inlineMultiline(text: unknown, continuationPrefix: string): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line, index) => (index === 0 ? line : `${continuationPrefix}${line.trimEnd()}`))
    .join("\n");
}

function formatStamp(seconds: number | null | undefined, fallback?: unknown): string {
  return String(fallback || "").trim() || formatTimestamp(seconds);
}

// 列表项里的换行必须缩进，否则后续行会跳出列表，把文档结构打乱。
function noteBody(note: NoteFields): string {
  return escapeMarkdown(String(note.text || ""))
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n  ");
}

function formatNoteItem(note: NoteFields, videoBaseUrl: string): string {
  const link = mdLink(formatTimestamp(note.atSec), videoHref(note.video, note.atSec, videoBaseUrl));
  const body = noteBody(note);
  return body ? `- ${link} ${body}` : `- ${link}`;
}

function byTime(left: NoteFields, right: NoteFields): number {
  return (Number(left.atSec) || 0) - (Number(right.atSec) || 0);
}

function formatGroup(notes: readonly NoteFields[], videoBaseUrl: string): string {
  const first = notes[0] ?? {};
  const title = escapeMarkdown(
    String(first.snapshot?.title || videoIdOf(first.video) || "未命名视频")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const owner = escapeMarkdown(String(first.snapshot?.author || "").trim());
  const segment = parseVideoKey(String(first.video || ""))?.segment ?? 1;
  const url = videoHref(first.video, 0, videoBaseUrl);
  const lines = [`# ${title}`, ""];
  const meta = [owner, segment > 1 ? `P${segment}` : ""].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);
  if (url) lines.push(url);
  if (meta || url) lines.push("");
  for (const note of [...notes].sort(byTime)) lines.push(formatNoteItem(note, videoBaseUrl));
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 把当前列表编成 Markdown。grouped 为 false 时当成同一个视频；
 * 为 true 时按视频分组，组内按时间点升序，组之间按最新笔记倒序。
 */
export function notesAsMarkdown(
  notes: NoteList,
  videoBaseUrl: string,
  { grouped = false }: NotesExportOptions = {},
): string {
  const list = noteList(notes);
  if (!list.length) return "";
  if (!grouped) return formatGroup(list, videoBaseUrl);

  const groups = new Map<string, NoteFields[]>();
  for (const note of list) {
    const key = String(note.video || "");
    const group = groups.get(key);
    if (group) group.push(note);
    else groups.set(key, [note]);
  }
  const latest = (group: readonly NoteFields[]): number =>
    Math.max(...group.map((note) => Number(note.createdAt) || 0));
  return [...groups.values()]
    .sort((left, right) => latest(right) - latest(left))
    .map((group) => formatGroup(group, videoBaseUrl))
    .join("\n");
}

// 以「- 」开头的值没有加引号，YAML 解析会报错；修它要同时改黄金样本。
function yamlScalar(value: unknown): string {
  const text = String(value ?? "");
  if (text === "") return '""';
  if (
    /[\n\r:#{}[\],&*?!<>=%@`|]/.test(text) ||
    text !== text.trim() ||
    /^(true|false|null|~|\d+(\.\d+)?)$/i.test(text) ||
    text.includes('"') ||
    text.includes("'")
  ) {
    // 双引号标量里的换行必须写成转义：原样换行重新解析时会折叠成空格，标题就静默变形了。
    return `"${text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")}"`;
  }
  return text;
}

// 键的字符集由 videoKey() 限定，不加引号也是合法的 YAML；认不出的键写成空值，不让它写坏文件头。
function yamlVideoKey(video: VideoKey | undefined): string {
  return parseVideoKey(String(video || "")) ? String(video) : '""';
}

function isoDate(value: string | number | Date | undefined): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function secondsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// 时间戳缺失时只写文字，不编一个 0:00 出来。text 是调用方已经转义、续行过的正文。
function stampedLine(prefix: string, seconds: number | null, text: string, hrefOf: HrefOf): string {
  const body = text.trim();
  if (seconds === null) return `${prefix}${body}`;
  const link = mdLink(formatStamp(seconds), hrefOf(seconds));
  return body ? `${prefix}${link} ${body}` : `${prefix}${link}`;
}

/** B站官方 AI 总结：总摘要加分段提纲，标题和要点各带时间戳。没有内容时返回空数组。 */
function officialSummaryLines(officialSummary: OfficialSummary | null | undefined, hrefOf: HrefOf): string[] {
  const summary = String(officialSummary?.summary || "").trim();
  const rawOutline = officialSummary?.outline;
  const outline: readonly (OutlinePart | null | undefined)[] = Array.isArray(rawOutline) ? rawOutline : [];
  if (!summary && !outline.length) return [];
  const lines = ["## B站官方总结", "", "> 来源：B站官方 AI 总结，由 B站生成，不是你配置的模型。", ""];
  if (summary) lines.push(escapeMarkdown(summary), "");
  for (const part of outline) {
    const title = escapeMarkdown(String(part?.title || "").trim()) || "（这一段没有标题）";
    lines.push(stampedLine("### ", secondsOrNull(part?.timestamp), title, hrefOf), "");
    const rawPoints = part?.points;
    const points: readonly (OutlinePoint | null | undefined)[] = Array.isArray(rawPoints) ? rawPoints : [];
    const pointLines = points
      .filter((point) => String(point?.content || "").trim())
      .map((point) =>
        stampedLine(
          "- ",
          secondsOrNull(point?.timestamp),
          inlineMultiline(escapeMarkdown(String(point?.content).trim()), "  "),
          hrefOf,
        ),
      );
    if (pointLines.length) lines.push(...pointLines, "");
  }
  return lines;
}

/** UP 主给视频划的分段，按开始时间列成目录。 */
function creatorChapterLines(chapters: LearningInput["creatorChapters"], hrefOf: HrefOf): string[] {
  const points = (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => ({
      start: secondsOrNull(chapter?.start),
      title: escapeMarkdown(String(chapter?.title || "").trim()),
    }))
    .filter((chapter) => chapter.start !== null);
  if (!points.length) return [];
  return [
    "## UP 主分段",
    "",
    "> 来源：UP 主在 B站为视频划分的章节。",
    "",
    ...points.map((chapter, index) => stampedLine("- ", chapter.start, chapter.title || `第 ${index + 1} 段`, hrefOf)),
    "",
  ];
}

/**
 * 当前视频的学习稿：YAML、B站官方总结、UP 主分段、章节（金句挂在章下）、笔记。
 * 缺的部分整节省略，没有正文时返回空串。
 * analysisFailures 是概览的失败区间：有的话在概览前注明内容不完整、缺了哪几段。
 * 官方总结和用户模型的概览同时出现时，两边都注明来源。
 */
export function learningAsMarkdown(
  {
    title = "",
    author = "",
    videoKey,
    exportedAt,
    analysis,
    analysisFailures,
    officialSummary,
    creatorChapters,
    notes,
  }: LearningInput = {},
  videoBaseUrl: string,
): string {
  const chapters: readonly ChapterPart[] = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
  const quotes: readonly QuotePart[] = Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [];
  const noteItems = noteList(notes);
  const hrefOf: HrefOf = (seconds) => videoHref(videoKey, seconds, videoBaseUrl);
  // B站自己给的导读：官方总结和 UP 主分段，都不是用户模型生成的。
  const guideLines = [...officialSummaryLines(officialSummary, hrefOf), ...creatorChapterLines(creatorChapters, hrefOf)];
  if (!chapters.length && !quotes.length && !noteItems.length && !guideLines.length) return "";

  const { grouped, orphans } = groupQuotesIntoChapters(chapters, quotes);
  const lines = [
    "---",
    `title: ${yamlScalar(title || videoIdOf(videoKey) || "未命名视频")}`,
    `videoKey: ${yamlVideoKey(videoKey)}`,
    `author: ${yamlScalar(author)}`,
    `url: ${yamlScalar(hrefOf(0))}`,
    `created_at: ${yamlScalar(isoDate(exportedAt))}`,
    "tags:",
    "  - 简幕",
    "---",
    "",
  ];

  // 和侧边栏一样，B站官方总结和 UP 主分段放在最前面。
  lines.push(...guideLines);
  const verdict = analysis?.verdict;
  const verdictSummary = String(verdict?.summary || "").trim();
  // 用官方总结写的结论没看过字幕，来源单独注明。
  const officialVerdict = Boolean(verdictSummary) && verdict?.source === "official";
  if (guideLines.length && (chapters.length || quotes.length)) {
    lines.push(
      officialVerdict
        ? "> 以下章节和金句由你配置的 AI 模型根据字幕生成。"
        : "> 以下结论、章节和金句由你配置的 AI 模型根据字幕生成。",
      "",
    );
  } else if (guideLines.length && verdictSummary && !officialVerdict) {
    lines.push("> 以下结论、章节和金句由你配置的 AI 模型根据字幕生成。", "");
  }

  // 缺块的概览读起来和完整的一模一样，不注明的话，学习稿会被当成全片概览。
  const failures = normalizeAnalysisFailures(analysisFailures);
  if (failures.length && (chapters.length || quotes.length)) {
    lines.push("> **概览内容不完整**：以下时间段生成失败，章节和金句里没有这几段的内容。");
    for (const failure of failures) {
      const span = `${formatStamp(failure.startSeconds)}–${formatStamp(failure.endSeconds)}`;
      const reason = failure.reason ? `：${inlineMultiline(escapeMarkdown(failure.reason), "> ")}` : "";
      lines.push(`> - ${span}${reason}`);
    }
    lines.push("");
  }

  // 一句话结论放在最前面，和侧边栏一样先回答「讲了什么、要不要看」。
  if (verdictSummary) {
    const verdictLabel = escapeMarkdown(String(verdict?.verdict || "").trim());
    const verdictValue = escapeMarkdown(String(verdict?.value || "").trim());
    const verdictReason = escapeMarkdown(String(verdict?.reason || "").trim());
    lines.push("## 一句话结论", "");
    if (verdictLabel) lines.push(`**${verdictLabel}**`, "");
    if (officialVerdict) lines.push("*这条结论由你配置的 AI 模型根据 B站官方总结写成，不是根据字幕。*", "");
    if (verdict?.incomplete) lines.push("*这条结论只基于概览里已有的部分，缺失时间段的内容没有算进去。*", "");
    lines.push(escapeMarkdown(verdictSummary), "");
    if (verdictValue) lines.push(`- 核心价值：${verdictValue}`);
    if (verdictReason) lines.push(`- 判断理由：${verdictReason}`);
    if (verdictValue || verdictReason) lines.push("");
  }

  const chapterLink = (chapter: ChapterPart): string =>
    mdLink(escapeMarkdown(formatStamp(chapter.timestampSeconds, chapter.timestamp)), hrefOf(chapter.timestampSeconds));
  const chapterHeading = (chapter: ChapterPart): string =>
    escapeMarkdown(String(chapter.title || "").trim()) ||
    escapeMarkdown(formatStamp(chapter.timestampSeconds, chapter.timestamp));
  const quoteLink = (quote: QuotePart): string =>
    mdLink(escapeMarkdown(formatStamp(quote.timestampSeconds, quote.timestamp)), hrefOf(quote.timestampSeconds));

  if (grouped.length) {
    lines.push("## 视频概览", "");
    for (const { chapter } of grouped) lines.push(`- ${chapterLink(chapter)} ${chapterHeading(chapter)}`);
    lines.push("");
    lines.push("## 章节", "");
    for (const { chapter, quotes: nested } of grouped) {
      lines.push(`### ${chapterLink(chapter)} ${chapterHeading(chapter)}`, "");
      const summary = escapeMarkdown(String(chapter.summary || "").trim());
      if (summary) lines.push(summary, "");
      for (const quote of nested) {
        const quoteText = escapeMarkdown(String(quote.quote || "").trim());
        lines.push(quoteText ? `> ${quoteLink(quote)} ${inlineMultiline(quoteText, "> ")}` : `> ${quoteLink(quote)}`);
        lines.push("");
      }
    }
  }

  const looseQuotes = grouped.length ? orphans : quotes;
  if (looseQuotes.length) {
    lines.push("## 金句", "");
    for (const quote of looseQuotes) {
      const text = escapeMarkdown(String(quote.quote || "").trim());
      lines.push(text ? `- ${quoteLink(quote)} ${inlineMultiline(text, "  ")}` : `- ${quoteLink(quote)}`);
    }
    lines.push("");
  }

  if (noteItems.length) {
    lines.push("## 我的时间戳笔记", "");
    for (const note of [...noteItems].sort(byTime)) lines.push(formatNoteItem(note, videoBaseUrl));
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
