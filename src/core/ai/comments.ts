// 评论区怎么说（PRD F23）：给写结论的模型准备评论，和校验模型写回来的那一块。纯逻辑，不碰平台。顶层只放字面量和函数，开关关着时整个模块不进包。
// 评论是别人写的内容：带联系方式、链接的整条在本机跳过，不发也不存；交给模型时只带序号、点赞数和正文，不带昵称。
// 模型只回序号，原评论由本机从同一批里取回，不让模型复述。只从构建开关 FEATURE_COMMENTS 的分支引用。
import type { OutputLang } from "../output-lang.ts";
import { startSecondsOf } from "../transcript/segment.ts";

/** 站点读回来的一条评论，和站点契约里的形状一致。 */
export interface CommentInput {
  readonly text: string;
  readonly likes: number;
  readonly pinned: boolean;
}

/** 存进概览、显示在界面上的一条原评论。 */
export interface CommentQuote {
  readonly text: string;
  readonly likes: number;
  readonly pinned: boolean;
}

/** 口碑标签：模型只能原样选一个。「评论还少」也可以由本机直接定，不发给模型。 */
export const COMMENT_TAGS: readonly string[] = ["好评居多", "有争议", "有人指出错误", "说是标题党", "评论还少"];
export const FEW_COMMENTS = "评论还少";
/** 章节上的标记：评论说这一段有误、可以跳过、最精彩。 */
export const MARK_KINDS: readonly string[] = ["有误", "可跳过", "精彩"];

export interface CommentPoint {
  readonly text: string;
  readonly quotes: readonly CommentQuote[];
}

export interface CommentMark {
  readonly start: number;
  readonly kind: string;
}

export interface CommentView {
  readonly tag: string;
  readonly line: string;
  readonly points: readonly CommentPoint[];
  readonly marks: readonly CommentMark[];
}

/** 少于这么多条就不发给模型，直接记成「评论还少」。 */
export const COMMENT_MIN = 3;
/** 最多发这么多条，每条最多这么多字。 */
export const COMMENT_SEND_MAX = 20;
export const COMMENT_SEND_CHARS = 300;
export const POINTS_MAX = 4;
export const QUOTES_PER_POINT = 3;
export const MARKS_MAX = 6;

// 明显的联系方式和链接：邮箱、网址、手机号、带号码的社交账号。宁可多跳几条，不把别人的联系方式发出去。
const CONTACT_PATTERNS: readonly RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /https?:\/\/|www\.|\b[\w-]+\.(?:com|cn|net|org|io|me|tv)\b/i,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /\+\d[\d\s-]{7,}\d/,
  // 英文的账号名前后要是词的边界，后面的号码里要有数字，免得把 timeline、pipeline 这类普通词当成账号。
  /(?<![a-z])(?:qq|vx|wx|wechat|telegram|whatsapp|line\s*id)(?![a-z])\s*[:：号]?\s*(?=[\w-]*\d)[\w-]{5,}/i,
  /(?:微信|v信|电报)\s*[:：号]?\s*[\w-]{5,}/i,
];

/** 正文里带了联系方式或链接。 */
export function hasContact(text: string): boolean {
  return CONTACT_PATTERNS.some((pattern) => pattern.test(text));
}

export interface CommentMaterial {
  /** 按发给模型的序号排的原评论，第 1 条是 kept[0]。 */
  readonly kept: readonly CommentQuote[];
  /** 填进提示词的那一段，每条一行。 */
  readonly text: string;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 准备发给模型的评论：跳过空的、带联系方式的，截短，最多 COMMENT_SEND_MAX 条，编上序号。 */
export function commentMaterial(comments: readonly CommentInput[]): CommentMaterial {
  const kept: CommentQuote[] = [];
  for (const comment of comments) {
    if (kept.length >= COMMENT_SEND_MAX) break;
    // 先看整条有没有联系方式再截短：联系方式在截掉的那一截里也要整条跳过。
    const whole = squash(String(comment?.text ?? ""));
    if (!whole || hasContact(whole)) continue;
    const text = whole.slice(0, COMMENT_SEND_CHARS);
    const likes = Number.isSafeInteger(comment.likes) && comment.likes > 0 ? comment.likes : 0;
    kept.push({ text, likes, pinned: comment.pinned === true });
  }
  const text = kept.map((comment, index) => `[${index + 1}]${comment.pinned ? " 置顶" : ""} 赞 ${comment.likes}：${comment.text}`).join("\n");
  return { kept, text };
}

/** 评论太少，不发给模型时本机记下的那一块。 */
export function fewComments(): CommentView {
  return { tag: FEW_COMMENTS, line: "", points: [], marks: [] };
}

/** 各字段按字符截断的上限，按语言取，和结论的做法一样留余量。 */
const CLIP: Readonly<Record<OutputLang, { readonly line: number; readonly point: number }>> = {
  zh: { line: 120, point: 80 },
  "zh-Hant": { line: 120, point: 80 },
  en: { line: 480, point: 320 },
};

const clip = (value: unknown, max: number): string => (typeof value === "string" ? squash(value).slice(0, max) : "");
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

function quotesOf(refs: unknown, kept: readonly CommentQuote[]): CommentQuote[] {
  const picked: CommentQuote[] = [];
  const seen = new Set<number>();
  for (const ref of listOf(refs)) {
    if (picked.length >= QUOTES_PER_POINT) break;
    const index = typeof ref === "number" ? ref : Number(ref);
    if (!Number.isInteger(index) || index < 1 || index > kept.length || seen.has(index)) continue;
    seen.add(index);
    const quote = kept[index - 1];
    if (quote) picked.push(quote);
  }
  return picked;
}

function marksOf(raw: unknown, chapterStarts: readonly unknown[]): CommentMark[] {
  const known = new Set(chapterStarts.map((start) => startSecondsOf(start)).filter((start): start is number => start !== null));
  const marks: CommentMark[] = [];
  for (const item of listOf(raw)) {
    if (marks.length >= MARKS_MAX) break;
    const source = item as { readonly at?: unknown; readonly kind?: unknown } | null;
    const start = startSecondsOf(source?.at);
    const kind = typeof source?.kind === "string" ? source.kind.trim() : "";
    if (start === null || !known.has(start) || !MARK_KINDS.includes(kind)) continue;
    if (marks.some((mark) => mark.start === start && mark.kind === kind)) continue;
    marks.push({ start, kind });
  }
  return marks.sort((left, right) => left.start - right.start);
}

/**
 * 模型写回来的评论区那一块，当不可信数据处理：标签不在几种里就整块不要；要点只留挂得上原评论的，
 * 原评论按序号从发出去的那批里取；章节标记要和现有章节的开始时间精确对上。坏了只丢这一块，不连累结论。
 */
export function commentViewOf(raw: unknown, kept: readonly CommentQuote[], chapterStarts: readonly unknown[], lang: OutputLang = "zh"): CommentView | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { readonly tag?: unknown; readonly line?: unknown; readonly points?: unknown; readonly marks?: unknown };
  const tag = typeof source.tag === "string" ? source.tag.trim() : "";
  if (!COMMENT_TAGS.includes(tag)) return null;
  const limits = CLIP[lang];
  const points: CommentPoint[] = [];
  for (const item of listOf(source.points)) {
    if (points.length >= POINTS_MAX) break;
    const point = item as { readonly text?: unknown; readonly refs?: unknown } | null;
    const text = clip(point?.text, limits.point);
    const quotes = quotesOf(point?.refs, kept);
    if (text && quotes.length > 0) points.push({ text, quotes });
  }
  return { tag, line: clip(source.line, limits.line), points, marks: marksOf(source.marks, chapterStarts) };
}

function storedQuote(raw: unknown): CommentQuote | null {
  const source = raw as { readonly text?: unknown; readonly likes?: unknown; readonly pinned?: unknown } | null;
  const text = clip(source?.text, COMMENT_SEND_CHARS);
  if (!text) return null;
  const likes = Number(source?.likes);
  return { text, likes: Number.isSafeInteger(likes) && likes > 0 ? likes : 0, pinned: source?.pinned === true };
}

/** 读存着的评论区那一块（本机记录、备份）：形状不对的丢掉，标签认不出就整块不要。 */
export function storedCommentView(raw: unknown): CommentView | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { readonly tag?: unknown; readonly line?: unknown; readonly points?: unknown; readonly marks?: unknown };
  const tag = typeof source.tag === "string" ? source.tag.trim() : "";
  if (!COMMENT_TAGS.includes(tag)) return null;
  const points: CommentPoint[] = [];
  for (const item of listOf(source.points).slice(0, POINTS_MAX)) {
    const point = item as { readonly text?: unknown; readonly quotes?: unknown } | null;
    const text = clip(point?.text, CLIP.en.point);
    const quotes = listOf(point?.quotes).slice(0, QUOTES_PER_POINT).map(storedQuote).filter((quote): quote is CommentQuote => quote !== null);
    if (text && quotes.length > 0) points.push({ text, quotes });
  }
  const marks: CommentMark[] = [];
  for (const item of listOf(source.marks).slice(0, MARKS_MAX)) {
    const mark = item as { readonly start?: unknown; readonly kind?: unknown } | null;
    const start = Number(mark?.start);
    const kind = typeof mark?.kind === "string" ? mark.kind : "";
    if (Number.isFinite(start) && start >= 0 && MARK_KINDS.includes(kind)) marks.push({ start: Math.floor(start), kind });
  }
  return { tag, line: clip(source.line, CLIP.en.line), points, marks };
}
