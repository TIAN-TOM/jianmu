// 笔记和学习稿的 Markdown 导出。视频链接由调用方给的函数按视频身份现生成。
// 标题、小标题、来源说明这些固定文字按语言出，缺省中文；模型写的内容、平台来的内容和用户自己的笔记原样写。
import { groupQuotesIntoChapters, type ChapterPart, type QuotePart } from "../ai/chunking.ts";
import { keyChapterStarts, verdictText, type OfficialSummary } from "../ai/verdict.ts";
import { inLang, type OutputLang } from "../output-lang.ts";
import { MARKDOWN_HANT } from "./markdown-hant.ts";
import { formatTimestamp } from "../transcript/segment.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../video-ref.ts";
import {
  normalizeAnalysisFailures,
  noteList,
  videoIdOf,
  type NoteFields,
  type NoteList,
} from "./records.ts";

export interface NotesExportOptions {
  readonly grouped?: boolean;
  /** 固定文字用哪种语言，缺省中文。 */
  readonly lang?: OutputLang;
}

const MARKDOWN_ZH = {
  untitled: "未命名视频",
  tag: "简幕",
  officialHeading: "## B站官方总结",
  officialSource: "> 来源：B站官方 AI 总结，由 B站生成，不是你配置的模型。",
  untitledSection: "（这一段没有标题）",
  creatorHeading: "## UP 主分段",
  creatorSource: "> 来源：UP 主在 B站为视频划分的章节。",
  section: (index: number) => `第 ${index} 段`,
  modelWroteChapters: "> 以下章节和金句由你配置的 AI 模型根据字幕生成。",
  modelWroteAll: "> 以下结论、章节和金句由你配置的 AI 模型根据字幕生成。",
  incomplete: "> **概览内容不完整**：以下时间段生成失败，章节和金句里没有这几段的内容。",
  failureReason: (reason: string) => `：${reason}`,
  verdictHeading: "## 一句话结论",
  verdictFromOfficial: "*这条结论由你配置的 AI 模型根据 B站官方总结写成，不是根据字幕。*",
  verdictIncomplete: "*这条结论只基于概览里已有的部分，缺失时间段的内容没有算进去。*",
  value: (text: string) => `- 核心价值：${text}`,
  reason: (text: string) => `- 判断理由：${text}`,
  keyMark: "（重点）",
  overviewHeading: "## 视频概览",
  chaptersHeading: "## 章节",
  quotesHeading: "## 金句",
  notesHeading: "## 我的时间戳笔记",
  fileNotes: "笔记",
  fileLearning: "学习稿",
};

export type MarkdownText = typeof MARKDOWN_ZH;

const MARKDOWN_EN: MarkdownText = {
  untitled: "Untitled video",
  tag: "jianmu",
  officialHeading: "## Bilibili official summary",
  officialSource: "> Source: Bilibili's official AI summary. Bilibili generated it, not the model you set up.",
  untitledSection: "(Untitled section)",
  creatorHeading: "## Creator chapters",
  creatorSource: "> Source: chapters the creator marked on Bilibili.",
  section: (index) => `Section ${index}`,
  modelWroteChapters: "> The chapters and key quotes below were generated from the subtitles by the AI model you set up.",
  modelWroteAll: "> The verdict, chapters and key quotes below were generated from the subtitles by the AI model you set up.",
  incomplete: "> **Incomplete overview**: these time ranges failed to generate, so the chapters and key quotes don't cover them.",
  failureReason: (reason) => `: ${reason}`,
  verdictHeading: "## One-line verdict",
  verdictFromOfficial: "*The AI model you set up wrote this verdict from the Bilibili official summary, not from the subtitles.*",
  verdictIncomplete: "*This verdict only covers the parts of the overview that were generated. Missing time ranges aren't included.*",
  value: (text) => `- Core value: ${text}`,
  reason: (text) => `- Reasoning: ${text}`,
  keyMark: " (key)",
  overviewHeading: "## Video overview",
  chaptersHeading: "## Chapters",
  quotesHeading: "## Key quotes",
  notesHeading: "## My timestamped notes",
  fileNotes: "notes",
  fileLearning: "study notes",
};

const textOf = (lang: OutputLang | undefined): MarkdownText => inLang(lang ?? "zh", MARKDOWN_ZH, MARKDOWN_EN, MARKDOWN_HANT);

/** 导出文件在视频没有标题时用的名字：笔记导出（notes）和学习稿（learning）各一个。 */
export function markdownFallbackName(kind: "notes" | "learning", lang: OutputLang = "zh"): string {
  return kind === "notes" ? textOf(lang).fileNotes : textOf(lang).fileLearning;
}

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

/** 给视频身份和起播秒数（不小于 0 的整数），回这个视频的页面链接；给不出时回空串。 */
export type VideoLinkOf = (ref: VideoRef, atSec: number) => string;

type HrefOf = (seconds: unknown) => string;

// 存着的链接字段不信：备份是用户导进来的文件，那个字段可以是任意网址。
// 链接只从视频键生成，认不出的键不给链接。
function videoHref(video: VideoKey | null | undefined, seconds: unknown, linkOf: VideoLinkOf): string {
  const ref = parseVideoKey(String(video || ""));
  if (!ref) return "";
  return linkOf(ref, Math.max(0, Math.floor(Number(seconds) || 0)));
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

function formatNoteItem(note: NoteFields, linkOf: VideoLinkOf): string {
  const link = mdLink(formatTimestamp(note.atSec), videoHref(note.video, note.atSec, linkOf));
  const body = noteBody(note);
  return body ? `- ${link} ${body}` : `- ${link}`;
}

function byTime(left: NoteFields, right: NoteFields): number {
  return (Number(left.atSec) || 0) - (Number(right.atSec) || 0);
}

function formatGroup(notes: readonly NoteFields[], linkOf: VideoLinkOf, t: MarkdownText): string {
  const first = notes[0] ?? {};
  const title = escapeMarkdown(
    String(first.snapshot?.title || videoIdOf(first.video) || t.untitled)
      .replace(/\s+/g, " ")
      .trim(),
  );
  const owner = escapeMarkdown(String(first.snapshot?.author || "").trim());
  const segment = parseVideoKey(String(first.video || ""))?.segment ?? 1;
  const url = videoHref(first.video, 0, linkOf);
  const lines = [`# ${title}`, ""];
  const meta = [owner, segment > 1 ? `P${segment}` : ""].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);
  if (url) lines.push(url);
  if (meta || url) lines.push("");
  for (const note of [...notes].sort(byTime)) lines.push(formatNoteItem(note, linkOf));
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * 把当前列表编成 Markdown。grouped 为 false 时当成同一个视频；
 * 为 true 时按视频分组，组内按时间点升序，组之间按最新笔记倒序。
 */
export function notesAsMarkdown(
  notes: NoteList,
  linkOf: VideoLinkOf,
  { grouped = false, lang = "zh" }: NotesExportOptions = {},
): string {
  const t = textOf(lang);
  const list = noteList(notes);
  if (!list.length) return "";
  if (!grouped) return formatGroup(list, linkOf, t);

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
    .map((group) => formatGroup(group, linkOf, t))
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

// 文件头的日期按用户本机时区写：导出那一刻用户那里是哪天就写哪天。
function localDate(value: string | number | Date | undefined): string {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
function officialSummaryLines(officialSummary: OfficialSummary | null | undefined, hrefOf: HrefOf, t: MarkdownText): string[] {
  const summary = String(officialSummary?.summary || "").trim();
  const rawOutline = officialSummary?.outline;
  const outline: readonly (OutlinePart | null | undefined)[] = Array.isArray(rawOutline) ? rawOutline : [];
  if (!summary && !outline.length) return [];
  const lines = [t.officialHeading, "", t.officialSource, ""];
  if (summary) lines.push(escapeMarkdown(summary), "");
  for (const part of outline) {
    const title = escapeMarkdown(String(part?.title || "").trim()) || t.untitledSection;
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
function creatorChapterLines(chapters: LearningInput["creatorChapters"], hrefOf: HrefOf, t: MarkdownText): string[] {
  const points = (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => ({
      start: secondsOrNull(chapter?.start),
      title: escapeMarkdown(String(chapter?.title || "").trim()),
    }))
    .filter((chapter) => chapter.start !== null);
  if (!points.length) return [];
  return [
    t.creatorHeading,
    "",
    t.creatorSource,
    "",
    ...points.map((chapter, index) => stampedLine("- ", chapter.start, chapter.title || t.section(index + 1), hrefOf)),
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
  linkOf: VideoLinkOf,
  lang: OutputLang = "zh",
): string {
  const t = textOf(lang);
  const chapters: readonly ChapterPart[] = Array.isArray(analysis?.chapters) ? analysis.chapters : [];
  const quotes: readonly QuotePart[] = Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [];
  const noteItems = noteList(notes);
  const hrefOf: HrefOf = (seconds) => videoHref(videoKey, seconds, linkOf);
  // B站自己给的导读：官方总结和 UP 主分段，都不是用户模型生成的。
  const guideLines = [...officialSummaryLines(officialSummary, hrefOf, t), ...creatorChapterLines(creatorChapters, hrefOf, t)];
  if (!chapters.length && !quotes.length && !noteItems.length && !guideLines.length) return "";

  const { grouped, orphans } = groupQuotesIntoChapters(chapters, quotes);
  const lines = [
    "---",
    `title: ${yamlScalar(title || videoIdOf(videoKey) || t.untitled)}`,
    `videoKey: ${yamlVideoKey(videoKey)}`,
    `author: ${yamlScalar(author)}`,
    `url: ${yamlScalar(hrefOf(0))}`,
    `created_at: ${yamlScalar(localDate(exportedAt))}`,
    "tags:",
    `  - ${t.tag}`,
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
      officialVerdict ? t.modelWroteChapters : t.modelWroteAll,
      "",
    );
  } else if (guideLines.length && verdictSummary && !officialVerdict) {
    lines.push(t.modelWroteAll, "");
  }

  // 缺块的概览读起来和完整的一模一样，不注明的话，学习稿会被当成全片概览。
  const failures = normalizeAnalysisFailures(analysisFailures);
  if (failures.length && (chapters.length || quotes.length)) {
    lines.push(t.incomplete);
    for (const failure of failures) {
      const span = `${formatStamp(failure.startSeconds)}–${formatStamp(failure.endSeconds)}`;
      const reason = failure.reason ? t.failureReason(inlineMultiline(escapeMarkdown(failure.reason), "> ")) : "";
      lines.push(`> - ${span}${reason}`);
    }
    lines.push("");
  }

  // 一句话结论放在最前面，和侧边栏一样先回答「讲了什么、要不要看」。
  if (verdictSummary) {
    const verdictLabel = verdictText(verdict?.verdict, lang);
    const verdictValue = escapeMarkdown(String(verdict?.value || "").trim());
    const verdictReason = escapeMarkdown(String(verdict?.reason || "").trim());
    lines.push(t.verdictHeading, "");
    if (verdictLabel) lines.push(`**${verdictLabel}**`, "");
    if (officialVerdict) lines.push(t.verdictFromOfficial, "");
    if (verdict?.incomplete) lines.push(t.verdictIncomplete, "");
    lines.push(escapeMarkdown(verdictSummary), "");
    if (verdictValue) lines.push(t.value(verdictValue));
    if (verdictReason) lines.push(t.reason(verdictReason));
    if (verdictValue || verdictReason) lines.push("");
  }

  const chapterLink = (chapter: ChapterPart): string =>
    mdLink(escapeMarkdown(formatStamp(chapter.timestampSeconds, chapter.timestamp)), hrefOf(chapter.timestampSeconds));
  // 结论标出的重点章节在标题后注明，和侧边栏的标记对应。
  const keyStarts = new Set(keyChapterStarts(analysis));
  const keyMark = (chapter: ChapterPart): string => (keyStarts.has(Math.floor(chapter.timestampSeconds)) ? t.keyMark : "");
  const chapterHeading = (chapter: ChapterPart): string =>
    (escapeMarkdown(String(chapter.title || "").trim()) ||
      escapeMarkdown(formatStamp(chapter.timestampSeconds, chapter.timestamp))) + keyMark(chapter);
  const quoteLink = (quote: QuotePart): string =>
    mdLink(escapeMarkdown(formatStamp(quote.timestampSeconds, quote.timestamp)), hrefOf(quote.timestampSeconds));

  if (grouped.length) {
    lines.push(t.overviewHeading, "");
    for (const { chapter } of grouped) lines.push(`- ${chapterLink(chapter)} ${chapterHeading(chapter)}`);
    lines.push("");
    lines.push(t.chaptersHeading, "");
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
    lines.push(t.quotesHeading, "");
    for (const quote of looseQuotes) {
      const text = escapeMarkdown(String(quote.quote || "").trim());
      lines.push(text ? `- ${quoteLink(quote)} ${inlineMultiline(text, "  ")}` : `- ${quoteLink(quote)}`);
    }
    lines.push("");
  }

  if (noteItems.length) {
    lines.push(t.notesHeading, "");
    for (const note of [...noteItems].sort(byTime)) lines.push(formatNoteItem(note, linkOf));
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
