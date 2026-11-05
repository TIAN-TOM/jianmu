// 模型输出的校验：概览的章节和金句，翻译批次的对齐。都当不可信数据重建一遍。
import { formatTimestamp } from "../transcript/segment.ts";

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
