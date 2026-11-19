// 回答引文、字幕原句和可跳转的时间点。超过一小时继续用分钟计时。

export interface TimeSpan {
  readonly min: number;
  readonly max: number;
}

/** 引用校验的合法区间；带 ranges 时要落在其中一段里。 */
export interface CitationRange extends TimeSpan {
  readonly ranges?: readonly TimeSpan[];
}

export interface FoundTimestamp {
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
export function timestampToSeconds(token: string | null | undefined): number | null {
  const match = /^(\d{1,5}):([0-5]\d)$/.exec(String(token || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function secondsToTimestamp(seconds: number): string {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

// 回答正文里的时间戳 token：单点 [M:SS] 或区间 [M:SS-M:SS]。
// 真实模型两种都会写（区间表示「这一段话的依据」），解析以起点为准。
const TIMESTAMP_TOKEN = /\[(\d{1,5}:[0-5]\d)(?:-(\d{1,5}:[0-5]\d))?\]/g;

/** 找出回答文本里的全部时间戳（区间取起点），非法 token 跳过。 */
export function extractTimestamps(text: string | null | undefined): FoundTimestamp[] {
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

// range 带 ranges 时（问答只选了部分不相邻的块）要落在其中一段里。
function isWithin(seconds: number, range: CitationRange | null | undefined): boolean {
  if (!range) return true;
  const inside = (part: TimeSpan): boolean =>
    seconds >= Math.floor(part.min) && seconds <= Math.ceil(part.max);
  if (!Number.isFinite(seconds)) return false;
  if (Array.isArray(range.ranges) && range.ranges.length) return range.ranges.some(inside);
  return inside(range);
}

/**
 * 从回答正文提取合法时间戳，并本地查出对应字幕原句作为依据。
 * 按播放位置取当时的字幕，不验证它能否支撑回答；
 * 越界的时间戳不生成依据条目，渲染时也不可点击。
 *
 * entries: 字幕原文 [{start, text}]
 * 返回 [{startSeconds, quote}]，按时间升序、同一秒去重。
 */
export function buildCitationsFromAnswer(
  answer: string | null | undefined,
  entries: readonly CitationEntry[] | null | undefined,
  timeRange?: CitationRange | null,
): Citation[] {
  const list: readonly CitationEntry[] = Array.isArray(entries) ? entries : [];
  if (!list.length) return [];
  const at = (seconds: number): string => {
    // 按播放位置查字幕时，片头的空白沿用第一句。
    if (seconds < Math.floor(Number(list[0]?.start) || 0)) return String(list[0]?.text || "").trim();
    for (let i = 0; i < list.length; i += 1) {
      const start = Math.floor(Number(list[i]?.start) || 0);
      const next = Math.floor(Number(list[i + 1]?.start) || Infinity);
      if (seconds >= start && seconds < next) return String(list[i]?.text || "").trim();
    }
    const last = list[list.length - 1];
    return last ? String(last.text || "").trim() : "";
  };

  const seen = new Set<number>();
  const citations: Citation[] = [];
  for (const item of extractTimestamps(answer)) {
    if (!isWithin(item.seconds, timeRange) || seen.has(item.seconds)) continue;
    seen.add(item.seconds);
    const quote = at(item.seconds);
    if (!quote) continue;
    citations.push({
      startSeconds: item.seconds,
      quote,
    });
  }
  return citations.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * 回答正文里的 [M:SS] 哪些可以做成可点击跳转：必须落在合法区间内。
 * 返回合法秒数的 Set——UI 拿它决定某个 token 渲染成按钮还是纯文本。
 */
export function clickableTimestamps(
  answer: string | null | undefined,
  timeRange?: CitationRange | null,
): Set<number> {
  return new Set(
    extractTimestamps(answer)
      .filter((item) => isWithin(item.seconds, timeRange))
      .map((item) => item.seconds),
  );
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
      return `[${secondsToTimestamp(row.seconds)}]`;
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
