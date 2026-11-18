// 模型输出的校验：概览的章节和金句，翻译和整理字幕批次的对齐。都当不可信数据重建一遍。
import { formatTimestamp, startSecondsOf } from "../transcript/segment.ts";

export interface Chapter {
  title: string;
  summary: string;
  timestampSeconds: number;
  timestamp: string;
}

export interface KeyQuote {
  quote: string;
  timestampSeconds: number;
  timestamp: string;
}

export interface Analysis {
  chapters: Chapter[];
  keyQuotes: KeyQuote[];
}

interface RawItem {
  readonly title?: unknown;
  readonly summary?: unknown;
  readonly quote?: unknown;
  readonly timestampSeconds?: unknown;
}

const rawItems = (value: unknown): readonly (RawItem | null | undefined)[] =>
  Array.isArray(value) ? value : [];

/**
 * 分块输出的宽容读法：章节和金句的时间以模型照抄的 start（或旧写法的 timestamp）为准，
 * 换算成秒交给 validateAnalysis；两样都读不出时才用模型自己算的 timestampSeconds。
 * 照抄字幕行开头的时间比让模型做换算可靠：一小时以上的视频常被算错。
 */
export function chunkFromModel(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const source = parsed as { readonly chapters?: unknown; readonly keyQuotes?: unknown };
  const withSeconds = (items: unknown): unknown =>
    Array.isArray(items)
      ? items.map((item: unknown) => {
          if (!item || typeof item !== "object") return item;
          const fields = item as { readonly start?: unknown; readonly timestamp?: unknown; readonly timestampSeconds?: unknown };
          const seconds = startSecondsOf(fields.start) ?? startSecondsOf(fields.timestamp);
          return seconds === null ? item : { ...fields, timestampSeconds: seconds };
        })
      : items;
  return { ...source, chapters: withSeconds(source.chapters), keyQuotes: withSeconds(source.keyQuotes) };
}

/**
 * 把模型输出当作不可信数据重建一遍：模型编造超出视频时长的时间戳是常态，
 * 越界条目直接丢掉，显示用的时间戳从校验过的秒数反推、不信模型给的字符串。
 */
export function validateAnalysis(analysis: unknown, maxSeconds: unknown, minSeconds: unknown = 0): Analysis {
  const source = analysis as { readonly chapters?: unknown; readonly keyQuotes?: unknown } | null | undefined;
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;
  // 分块时每块开头带了上一块的结尾，模型有时会顺手为那段也开一章；
  // 那段不归本块管，越界的直接丢掉。
  const safeMin =
    Number.isFinite(Number(minSeconds)) && Number(minSeconds) > 0
      ? Number(minSeconds)
      : 0;

  const safeString = (value: unknown, maxLength: number): string =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";

  const safeSeconds = (value: unknown): number | null => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < safeMin || seconds > safeMax) {
      return null;
    }
    return Math.floor(seconds);
  };

  const chapters = rawItems(source?.chapters)
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        summary: safeString(chapter?.summary, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter((chapter) => chapter !== null)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = rawItems(source?.keyQuotes)
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter((quote) => quote !== null)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  // 只留章节和金句，模型多给的字段不透传。
  return { chapters, keyQuotes };
}

export interface SourceSegment {
  readonly id?: unknown;
  readonly text?: unknown;
}

export interface RejectedSegment {
  readonly id: string;
  readonly reason: string;
}

interface AlignedBatch {
  accepted: Record<string, string>;
  rejected: RejectedSegment[];
}

/**
 * 按 id 把模型返回的结果对回原分段。不能按数组下标对齐：模型偶尔漏条、多条
 * 或打乱顺序，按下标会把文字接到错误的时间戳上。对不上的条目丢弃，保留原文。
 */
function alignSegmentBatch(
  parsed: unknown,
  sourceSegments: readonly SourceSegment[] | null | undefined,
  accept: (text: string, source: string | undefined) => boolean,
  rejectReason: string,
): AlignedBatch {
  const sourceList: readonly SourceSegment[] = Array.isArray(sourceSegments) ? sourceSegments : [];
  const sources = new Map(
    sourceList.map((segment): [string, string] => [
      String(segment.id),
      String(segment.text || ""),
    ]),
  );

  const accepted: Record<string, string> = {};
  const rejected: RejectedSegment[] = [];
  const seen = new Set<string>();

  const items = (parsed as { readonly segments?: unknown } | null | undefined)?.segments;
  const list: readonly (SourceSegment | null | undefined)[] = Array.isArray(items) ? items : [];
  for (const item of list) {
    const id = typeof item?.id === "string" ? item.id : String(item?.id ?? "");
    const text = typeof item?.text === "string" ? item.text.trim() : "";

    if (!sources.has(id)) {
      rejected.push({ id, reason: "UNKNOWN_ID" });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ id, reason: "DUPLICATE_ID" });
      continue;
    }
    seen.add(id);

    if (!text) {
      rejected.push({ id, reason: "EMPTY_TEXT" });
      continue;
    }
    if (!accept(text, sources.get(id))) {
      rejected.push({ id, reason: rejectReason });
      continue;
    }
    accepted[id] = text;
  }

  for (const id of sources.keys()) {
    if (!seen.has(id)) rejected.push({ id, reason: "MISSING" });
  }

  return { accepted, rejected };
}

const cjkCount = (text: string | null | undefined): number => (String(text || "").match(/[㐀-鿿]/g) || []).length;
const latinCount = (text: string | null | undefined): number => (String(text || "").match(/[A-Za-z]/g) || []).length;

/**
 * 判断模型是真的翻译了，还是把原文抄了回来。两个方向的证据不同：
 * 译成中文时译文里必须出现中文（原文拉丁字母太少如日韩文则不检查）；
 * 译成英文时看「中文明显变少」而非「出现拉丁字母」——短句英译可能只有 OK 两个字母。
 */
export function looksLikeTranslation(
  translated: string | null | undefined,
  source: string | null | undefined,
  targetLang = "zh",
): boolean {
  if (targetLang === "en") {
    const sourceCjk = cjkCount(source);
    if (sourceCjk < 10) return true;
    return cjkCount(translated) < sourceCjk / 2;
  }
  if (latinCount(source) < 20) return true;
  return cjkCount(translated) > 0;
}

export function alignTranslatedSegments(
  parsed: unknown,
  sourceSegments: readonly SourceSegment[] | null | undefined,
  { targetLang = "zh" }: { readonly targetLang?: string } = {},
): { translated: Record<string, string>; rejected: RejectedSegment[] } {
  const { accepted, rejected } = alignSegmentBatch(
    parsed,
    sourceSegments,
    (text, source) => looksLikeTranslation(text, source, targetLang),
    "NOT_TRANSLATED",
  );
  return { translated: accepted, rejected };
}

/** 去掉标点、符号和空白以后的文字：整理字幕只许加标点，比的是剩下的字。 */
const bareText = (text: string): string[] => [...text.normalize("NFKC").replace(/[\p{P}\p{S}\s]/gu, "")];

/** 两串字之间要改几个字（增、删、换各算一次）。 */
function editDistance(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/** 整理字幕最多改几成的字：同音错字改几个可以，改写、删减、添话不行。 */
export const TIDY_MAX_EDIT_RATIO = 0.08;

/**
 * 整理后的这一段能不能用：去掉标点和空白以后和原文比，字数差不超过 5%（至少容 1 个字），
 * 改动的字数不超过 8%（至少容 1 个字）。超了就是模型把字幕改成了自己的话，这一段不用，照旧显示原文。
 */
export function acceptTidied(source: string, tidied: string): boolean {
  const before = bareText(source);
  const after = bareText(tidied);
  if (!after.length) return false;
  if (before.join("") === after.join("")) return true;
  if (Math.abs(before.length - after.length) > Math.max(1, Math.floor(before.length * 0.05))) return false;
  return editDistance(before, after) <= Math.max(1, Math.ceil(before.length * TIDY_MAX_EDIT_RATIO));
}

/** 整理字幕一批的对齐：按 id 对回原段，改得太多的段记成 REWRITTEN，交回去照旧显示原文。 */
export function alignTidiedSegments(
  parsed: unknown,
  sourceSegments: readonly SourceSegment[] | null | undefined,
): { tidied: Record<string, string>; rejected: RejectedSegment[] } {
  const { accepted, rejected } = alignSegmentBatch(parsed, sourceSegments, (text, source) => acceptTidied(source ?? "", text), "REWRITTEN");
  return { tidied: accepted, rejected };
}
