// 字幕后处理：把逐条字幕重组成可阅读的语义段落。
// 中文信息密度高，CJK 内容用更短的段落阈值，否则一段会长得没法读；
// B 站 AI 字幕普遍没有标点，额外把原始字幕行边界作为可切分点，避免按字符数硬切把词切成两半。

// 字幕条目，时间单位是秒。数据来自平台或用户文件，字段可能缺失，读的时候都按宽容处理。
export interface CaptionEntry {
  readonly text?: string | null | undefined;
  readonly start?: number | null | undefined;
  readonly duration?: number | null | undefined;
}

export type MaybeCaptionEntry = CaptionEntry | null | undefined;
export type CaptionEntries = readonly MaybeCaptionEntry[] | null | undefined;

export interface SegmentLimits {
  readonly minChars: number;
  readonly idealChars: number;
  readonly maxChars: number;
  readonly maxSeconds: number;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  text: string;
  texts: string[];
}

interface Piece {
  text: string;
  start: number;
  semanticEnd: boolean;
  clauseEnd: boolean;
  entryEnd: boolean;
  sourceOrder: string;
}

// CJK 按字符数折算到和拉丁文本相近的信息量。
export const LATIN_LIMITS: SegmentLimits = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

export const CJK_LIMITS: SegmentLimits = Object.freeze({
  minChars: 30,
  idealChars: 90,
  maxChars: 160,
  maxSeconds: 20,
});

const CJK_PATTERN = /[\u3400-\u9fff]/g;

/** CJK 字符占比超过三成就按中文排版处理。 */
export function limitsForEntries(entries: CaptionEntries): SegmentLimits {
  const list: readonly MaybeCaptionEntry[] = Array.isArray(entries) ? entries : [];
  const sample = list
    .slice(0, 200)
    .map((entry) => String(entry?.text || ""))
    .join("");
  if (!sample) return LATIN_LIMITS;
  const cjkCount = (sample.match(CJK_PATTERN) || []).length;
  return cjkCount / sample.length > 0.3 ? CJK_LIMITS : LATIN_LIMITS;
}

export function normalizeCaptionText(text: string | null | undefined): string {
  return String(text || "")
    .replace(/\s+/g, " ")
    // 用后顾断言而非捕获组：捕获组会吃掉右侧汉字，导致连续多个
    // 「汉字 空格 汉字」只清理得掉第一处。
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

// 优先切在标点上，退而求其次词边界，最后才按字符数硬切。
export function splitOversizedThought(text: string | null | undefined, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/** 把逐条字幕重组成语义段落。每段保留贡献首个文字的那条字幕的时间戳。 */
export function groupTranscriptEntries(entries: CaptionEntries, limits?: SegmentLimits | null): TranscriptSegment[] {
  const list: readonly MaybeCaptionEntry[] = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return [];
  const activeLimits = limits || limitsForEntries(list);

  const pieces: Piece[] = [];
  list.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry?.start))
      ? Number(entry?.start)
      : 0;
    const duration = Math.max(0, Number(entry?.duration) || 0);
    const sentenceParts: readonly string[] = text.match(
      /[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g,
    ) || [text];
    let consumedChars = 0;
    const entryPieces: Piece[] = [];

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(
        cleanPart,
        activeLimits.maxChars,
      );
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length
          ? Math.min(1, consumedChars / text.length)
          : 0;
        entryPieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          entryEnd: false,
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });

    const lastPiece = entryPieces[entryPieces.length - 1];
    if (lastPiece) {
      lastPiece.entryEnd = true;
      pieces.push(...entryPieces);
    }
  });

  const grouped: TranscriptSegment[] = [];
  let current: { start: number; text: string } | null = null;

  const flush = (): void => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= activeLimits.minChars;
    const reachedIdeal = current.text.length >= activeLimits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      ((piece.clauseEnd || piece.entryEnd) &&
        (reachedIdeal ||
          current.text.length >= activeLimits.maxChars ||
          elapsed >= activeLimits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= activeLimits.maxChars ||
        elapsed >= activeLimits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(activeLimits.maxChars * 1.2) ||
      elapsed >= activeLimits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

export function formatTimestamp(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// 纯文本用于展示和导出；带 [M:SS] 前缀的版本喂给模型，让它能引用真实时间点。
export function buildTranscriptTexts(entries: CaptionEntries): { plain: string; timestamped: string } {
  const lines: readonly MaybeCaptionEntry[] = Array.isArray(entries) ? entries : [];
  const plain = lines
    .map((entry) => normalizeCaptionText(entry?.text))
    .filter(Boolean)
    .join(" ");
  const timestamped = lines
    .map((entry) => {
      const text = normalizeCaptionText(entry?.text);
      return text ? `[${formatTimestamp(entry?.start)}] ${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
  return { plain: plain.trim(), timestamped: timestamped.trim() };
}
