// 把播放器取回的带时间轴的字幕正文解析成一句一句：开始的秒数和文字。纯逻辑，不碰页面。
// 没有文字、只有空白或换行的事件丢掉，同一事件的几个片段拼成一句；时间往回走、条数或字数超过上限的整份不用；读不懂返回 null，不抛。
// 只从读播放器字幕的那个模块引用，顶层只放字面量和函数：构建开关关着时整个模块不进包。

export interface CaptionLine {
  readonly start: number;
  readonly text: string;
}

export interface CaptionJsonLimits {
  readonly cues: number;
  readonly cueText: number;
  readonly totalText: number;
  readonly seconds: number;
}

type Fields = Readonly<Record<string, unknown>>;
const fields = (value: unknown): Fields | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null);

/** 一个事件里各片段拼成的一句，空白压成一个空格；不是文字的片段整个事件不认。 */
function lineOf(pieces: readonly unknown[]): string | null {
  let joined = "";
  for (const piece of pieces) {
    const text = fields(piece)?.utf8;
    if (typeof text !== "string") return null;
    joined += text;
  }
  return joined.replace(/\s+/g, " ").trim();
}

export function parseCaptionJson(text: string, limits: CaptionJsonLimits): CaptionLine[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const events = fields(data)?.events;
  if (!Array.isArray(events)) return null;
  const lines: CaptionLine[] = [];
  let last = -1;
  let total = 0;
  for (const raw of events) {
    const event = fields(raw);
    if (!event) return null;
    // 不带文字片段的事件只管显示的位置，跳过。
    if (event.segs === undefined) continue;
    if (!Array.isArray(event.segs)) return null;
    const line = lineOf(event.segs);
    if (line === null) return null;
    if (!line) continue;
    const startMs = event.tStartMs;
    if (typeof startMs !== "number" || !Number.isFinite(startMs) || startMs < 0) return null;
    const start = startMs / 1000;
    if (start < last || start > limits.seconds || lines.length >= limits.cues) return null;
    last = start;
    const clipped = line.slice(0, limits.cueText);
    total += clipped.length;
    if (total > limits.totalText) return null;
    lines.push({ start, text: clipped });
  }
  return lines;
}
