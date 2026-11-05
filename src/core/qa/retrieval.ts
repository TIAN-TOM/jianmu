/**
 * 视频问答的本地检索：不花额外的模型费用和延迟，把长字幕筛到能塞进
 * 一次请求的规模。三级阶梯：
 *
 *   full     总字数在预算内 → 整份直送，质量最高
 *   selected 本地打分取 Top-K，带上相邻块保证上下文完整
 *   skeleton 全部得分为零（问的是「总结一下」这类零内容词问题）时
 *            送每块开头的骨架，配合系统提示词让模型如实回答未找到
 *
 * 打分信号有两个：问题的字符 2-gram / 拉丁词在块文本中的直接命中；
 * 已生成概览时的章节标题与摘要命中加权——章节是付费换来的语义压缩，
 * 白捡的检索索引。
 */
import type { TimeSpan } from "./citations.ts";

export interface QaChunk {
  readonly index: number;
  readonly startSeconds: number;
  readonly endSeconds: number; // 末段的起点，不含末段时长
  readonly text: string;
}

export interface SkeletonChunk extends QaChunk {
  readonly skeleton: true;
}

export interface QaChapter {
  readonly title?: string;
  readonly summary?: string;
  readonly timestampSeconds: number;
}

export interface ScoredChunk {
  readonly chunk: QaChunk;
  readonly score: number;
}

/** 送进模型的范围：min、max 是外包区间，ranges 分段列出。 */
export interface ContextTimeRange extends TimeSpan {
  readonly ranges: readonly TimeSpan[];
}

export interface QaContext {
  readonly mode: "full" | "selected" | "skeleton";
  readonly chunks: readonly (QaChunk | SkeletonChunk)[];
  readonly timeRange: ContextTimeRange | null;
}

export interface SelectContextInput {
  readonly chunks?: readonly QaChunk[];
  readonly question?: string | null;
  readonly chapters?: readonly QaChapter[];
  readonly totalDurationSeconds?: number;
  readonly maxChunks?: number;
  readonly budgetChars?: number;
}

// 问题里的高频功能词几乎必然命中字幕正文，会把「真正的内容词」淹没，
// 也让「总结一下」这类问题假性得分、永远走不到兜底。先摘掉。
export const STOP_TERMS: ReadonlySet<string> = new Set([
  // 中文双字
  "什么", "怎么", "怎样", "为何", "为什么", "如何", "是不是", "有没有",
  "这个", "那个", "哪个", "这些", "那些", "他们", "我们", "你们", "自己",
  "还是", "就是", "不是", "可以", "应该", "需要", "一下", "一些", "这里",
  "那里", "因为", "所以", "但是", "如果", "虽然", "或者", "以及", "还有",
  "视频", "字幕", "老师", "作者", "up主", "主讲", "讲到", "说到",
  // 中文单字（短问句兜底）
  "的", "了", "吗", "呢", "吧", "啊", "是", "在", "有", "和", "与",
  "或", "及", "之", "说", "讲", "做", "看", "听",
  // 拉丁
  "the", "and", "for", "what", "how", "why", "who", "when", "where",
  "this", "that", "with", "from", "about", "into", "video",
]);

/**
 * 从问题里抽出要检索的词项：
 * - 拉丁 / 数字连续串作整词（≥2 字符，小写）
 * - 中日韩连续串切成字符 2-gram；孤立的单词保留该字
 * 返回数组（顺序无关，内部用 Set 去重）。
 */
export function questionTerms(question: string | null | undefined): string[] {
  const source = String(question || "");
  const terms = new Set<string>();
  const add = (term: string): void => {
    if (term && !STOP_TERMS.has(term)) terms.add(term);
  };

  for (const match of source.matchAll(/[A-Za-z0-9]+/g)) {
    const word = match[0].toLowerCase();
    if (word.length >= 2) add(word);
  }
  for (const match of source.matchAll(
    /[\u3400-\u4dbf\u4e00-\u9fff]+/g,
  )) {
    const run = match[0];
    if (run.length === 1) {
      add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      add(run.slice(i, i + 2));
    }
  }
  return [...terms];
}

/** 单个词项在文本中的出现次数（indexOf 循环，避免正则转义问题）。 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    count += 1;
    cursor = at + needle.length;
  }
  return count;
}

// 单个词项的贡献封顶：某个高频词出现五十次不该淹没其它词项的信号。
const PER_TERM_CAP = 3;

function scoreText(text: string, terms: readonly string[]): number {
  const haystack = String(text || "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += Math.min(countOccurrences(haystack, term), PER_TERM_CAP);
  }
  return score;
}

/** 找出覆盖 startSeconds 的章节（最后一个起点 ≤ 它的章节）。 */
function chapterAt(chapters: readonly QaChapter[], startSeconds: number): QaChapter | null {
  let owner: QaChapter | null = null;
  for (const chapter of chapters) {
    const seconds = Number(chapter?.timestampSeconds);
    if (!Number.isFinite(seconds)) continue;
    if (seconds <= startSeconds) owner = chapter;
    else break;
  }
  return owner;
}

// 章节标题 / 摘要是语义压缩，命中一个词项顶正文里的三次偶遇。
const CHAPTER_BOOST_PER_TERM = 3;

/**
 * 给每个块打分。chapters 可选（概览没生成时就没有）：
 * 形如 [{title, summary, timestampSeconds}]。
 */
export function scoreChunks(
  chunks: readonly QaChunk[],
  question: string | null | undefined,
  chapters: readonly QaChapter[] = [],
): ScoredChunk[] {
  const terms = questionTerms(question);
  return chunks.map((chunk) => {
    let score = scoreText(chunk.text, terms);
    const chapter = chapterAt(chapters, chunk.startSeconds);
    if (chapter) {
      const chapterText = `${chapter.title || ""} ${chapter.summary || ""}`;
      score += scoreText(chapterText, terms) * CHAPTER_BOOST_PER_TERM;
    }
    return { chunk, score };
  });
}

/** 每块只留开头一段当骨架；时间戳原样保留，引用校验才有的放矢。 */
function toSkeletonChunk(chunk: QaChunk): SkeletonChunk {
  const firstLine = String(chunk.text || "").split("\n")[0] || "";
  return {
    index: chunk.index,
    startSeconds: chunk.startSeconds,
    endSeconds: chunk.endSeconds,
    text: firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine,
    skeleton: true,
  };
}

/**
 * 引用校验的合法区间，只覆盖送进模型的块。
 * 块的 endSeconds 是末段的起点，会低估一段时长：每块的上界取完整列表 list 里下一块的起点；
 * 没有下一块（全片最后一块）时以视频总长封顶，没有总长才用 endSeconds。
 * 选中的块不相邻时，ranges 分段列出，中间没送进模型的那段不算合法引用；
 * min、max 是外包区间。
 */
function timeRangeOf(
  chunks: readonly QaChunk[],
  totalDurationSeconds: number | undefined,
  list: readonly QaChunk[] = chunks,
): ContextTimeRange | null {
  if (!chunks.length) return null;
  const total = Number(totalDurationSeconds);
  const upperOf = (chunk: QaChunk): number => {
    const next = list.find((candidate) => candidate.index === chunk.index + 1);
    if (next) return Math.max(next.startSeconds, chunk.endSeconds);
    if (Number.isFinite(total) && total > 0) return Math.max(Math.floor(total), chunk.endSeconds);
    return chunk.endSeconds;
  };
  const ranges: { min: number; max: number }[] = [];
  for (const chunk of [...chunks].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const range = { min: chunk.startSeconds, max: upperOf(chunk) };
    const last = ranges[ranges.length - 1];
    if (last && range.min <= last.max) last.max = Math.max(last.max, range.max);
    else ranges.push(range);
  }
  return {
    min: ranges[0]!.min, // chunks 非空，ranges 至少有一段
    max: Math.max(...ranges.map((range) => range.max)),
    ranges,
  };
}

export const DEFAULT_MAX_CHUNKS = 6;
export const DEFAULT_BUDGET_CHARS = 12_000;

/**
 * 主入口。返回：
 *   mode: "full" | "selected" | "skeleton"
 *   chunks: 实际送入模型的块（selected / skeleton 可能只是子集）
 *   timeRange: {min, max, ranges} —— 引用校验的合法区间
 */
export function selectContext({
  chunks,
  question,
  chapters = [],
  totalDurationSeconds,
  maxChunks = DEFAULT_MAX_CHUNKS,
  budgetChars = DEFAULT_BUDGET_CHARS,
}: SelectContextInput = {}): QaContext {
  const list: readonly QaChunk[] = (Array.isArray(chunks) ? chunks : []).filter(Boolean);
  if (!list.length || !String(question || "").trim()) {
    return { mode: "full", chunks: list, timeRange: timeRangeOf(list, totalDurationSeconds) };
  }

  // 阶梯 0 只看总量：预算内整份直送质量最高，块数不设限。
  const totalChars = list.reduce((sum, chunk) => sum + (chunk.text?.length || 0), 0);
  if (totalChars <= budgetChars) {
    return { mode: "full", chunks: list, timeRange: timeRangeOf(list, totalDurationSeconds) };
  }

  const scored = scoreChunks(list, question, chapters);
  const relevant = scored.filter((entry) => entry.score > 0);

  if (!relevant.length) {
    // 阶梯 2：零内容词问题或字幕确实无关。骨架 + 系统提示词的
    // 「找不到就明说」，两种走向都符合「不编造」的要求。
    const skeleton = list.map(toSkeletonChunk);
    return {
      mode: "skeleton",
      chunks: skeleton,
      timeRange: timeRangeOf(list, totalDurationSeconds),
    };
  }

  relevant.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
  const picked = new Set(
    relevant.slice(0, maxChunks).map((entry) => entry.chunk.index),
  );
  // 相邻块一并带上：答案经常跨块边界，孤立的半段话会让引用悬空。
  // 只对原始命中的块各扩左右一块，Set.add 幂等，不需要按"已在集合里"
  // 抄近路——前一块已选并不意味着本块的后一块已被覆盖，跳过会漏块。
  for (const index of [...picked]) {
    const previous = list.find((chunk) => chunk.index === index - 1);
    if (previous) picked.add(previous.index);
    const next = list.find((chunk) => chunk.index === index + 1);
    if (next) picked.add(next.index);
  }

  // picked 里的序号都取自 list，find 必定找得到。
  const ordered = [...picked]
    .sort((a, b) => a - b)
    .map((index) => list.find((chunk) => chunk.index === index)!);

  // 预算从尾部裁：保住最早的上下文，至少留一块。
  const trimmed: QaChunk[] = [];
  let used = 0;
  for (const chunk of ordered) {
    if (used + (chunk.text?.length || 0) > budgetChars && trimmed.length) break;
    trimmed.push(chunk);
    used += chunk.text?.length || 0;
  }

  return {
    mode: "selected",
    chunks: trimmed,
    timeRange: timeRangeOf(trimmed, totalDurationSeconds, list),
  };
}
