// 回答里的时间点：切成可跳转的片段，用短引核对字幕原句。超过一小时继续用分钟计时。
import { formatTimestamp } from "../transcript/segment.ts";

export interface TimeSpan {
  readonly min: number;
  readonly max: number;
}

interface FoundTimestamp {
  readonly raw: string;
  readonly seconds: number;
}

/** 普通片段只有 text；时间戳片段的 text 是原文 label，并带 seconds。 */
export interface AnswerSegment {
  readonly text: string;
  readonly seconds?: number;
}

/** 字幕原文的一条。 */
export interface CitationEntry {
  readonly start: number;
  readonly text: string;
}

export interface Citation {
  readonly startSeconds: number;
  readonly quote: string;
}

/** "03:12" → 192；非法输入返回 null。分钟数不设上限：超长直播回放的
 *  formatTimestamp 会产出 1000:30 这种四位分钟，正则必须接得住。 */
function timestampToSeconds(token: string | null | undefined): number | null {
  const match = /^(\d{1,5}):([0-5]\d)$/.exec(String(token || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// 回答正文里的时间戳 token：单点 [M:SS] 或区间 [M:SS-M:SS]。
// 真实模型两种都会写（区间表示「这一段话的依据」），解析以起点为准。
const TIMESTAMP_TOKEN = /\[(\d{1,5}:[0-5]\d)(?:-(\d{1,5}:[0-5]\d))?\]/g;

/** 找出回答文本里的全部时间戳（区间取起点），非法 token 跳过。 */
function extractTimestamps(text: string | null | undefined): FoundTimestamp[] {
  const source = String(text || "");
  const found: FoundTimestamp[] = [];
  for (const match of source.matchAll(TIMESTAMP_TOKEN)) {
    const seconds = timestampToSeconds(match[1]);
    if (seconds !== null) {
      found.push({ raw: match[0], seconds });
    }
  }
  return found;
}

/**
 * 把回答切成 普通文本 / 时间戳 片段数组，供渲染层拼装
 * （时间戳片段带 seconds 与原文 label，普通片段只有 text）。
 * 渲染层据此决定时间戳是可点按钮还是纯文本，逻辑单点维护。
 */
export function splitAnswerByTimestamps(answer: string | null | undefined): AnswerSegment[] {
  const source = String(answer || "");
  const segments: AnswerSegment[] = [];
  let cursor = 0;
  for (const match of source.matchAll(TIMESTAMP_TOKEN)) {
    const [, start = "", end] = match;
    const seconds = timestampToSeconds(start);
    const at = match.index;
    if (seconds === null) continue;
    if (at > cursor) segments.push({ text: source.slice(cursor, at) });
    // 按钮文案不带方括号；区间保留「起-止」形式。
    const label = end ? `${start}-${end}` : start;
    segments.push({ text: label, seconds });
    cursor = at + match[0].length;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor) });
  return segments;
}

/** 将回答里的短引对回本次发出的字幕行，再生成历史记录和界面共用的时间点。 */
export function groundQaAnswer(answer: string, entries: readonly CitationEntry[]): { answer: string; citations: Citation[] } {
  const rows = entries.map((entry) => ({
    seconds: Math.floor(entry.start),
    quote: entry.text,
    searchable: normaliseQuote(entry.text),
  }));
  const accepted: string[] = [];
  const quotes = new Map<number, Set<string>>();
  for (const line of answer.split(/\r?\n/)) {
    const found: typeof rows = [];
    let invalid = false;
    const mark = /【(\d{1,5}:[0-5]\d)\s*[|｜]([^【】\n]+)】/g;
    // 旧式裸时间和不完整的标记都缺少可核对的原文。
    const prose = line.replace(mark, "");
    if (/[【】]/.test(prose) || extractTimestamps(prose).length) continue;
    const text = line.replace(mark, (_marker, time: string, quote: string) => {
      const needle = normaliseQuote(quote);
      const matches = needle ? rows.filter((row) => row.searchable.includes(needle)) : [];
      const seconds = timestampToSeconds(time);
      const hinted = matches.filter((row) => row.seconds === seconds);
      const candidates = hinted.length ? hinted : matches;
      if (candidates.length !== 1) {
        invalid = true;
        return "";
      }
      const row = candidates[0]!;
      found.push(row);
      return `[${formatTimestamp(row.seconds)}]`;
    });
    if (invalid || !found.length) continue;
    accepted.push(text);
    for (const row of found) {
      const snippets = quotes.get(row.seconds) ?? new Set<string>();
      snippets.add(row.quote);
      quotes.set(row.seconds, snippets);
    }
  }
  const citations = [...quotes].sort(([a], [b]) => a - b)
    .map(([startSeconds, snippets]) => ({ startSeconds, quote: [...snippets].join(" ") }));
  return { answer: accepted.join("\n"), citations };
}

function normaliseQuote(text: string): string {
  return text.normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}
