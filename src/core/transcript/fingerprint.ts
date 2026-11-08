// 内容指纹：派生结果记下依据的哪一版字幕或文字，依据变了才看得出来。只算内容，不算地址、凭据和抓取时间。
import { sha256Hex } from "../task-keys.ts";
import { normalizeCaptionText, type CaptionEntries } from "./segment.ts";

const FINGERPRINT_LENGTH = 16;

// 时间按毫秒取整，同一份字幕换个浮点写法得出同一串。
const millis = (value: unknown): string => String(Math.round((Number(value) || 0) * 1000));

/** 每条「开始|时长|规范化正文」排好序，取 SHA-256 的前 16 位。空白条目不算。 */
export async function transcriptFingerprint(entries: CaptionEntries): Promise<string> {
  const lines = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ entry, text: normalizeCaptionText(entry?.text) }))
    .filter(({ text }) => text !== "")
    .map(({ entry, text }) => `${millis(entry?.start)}|${millis(entry?.duration)}|${text}`)
    .sort();
  return (await sha256Hex(lines.join("\n"))).slice(0, FINGERPRINT_LENGTH);
}

/** 一段文字（官方总结正文、标题加简介）规范化后取指纹。 */
export async function textFingerprint(text: string): Promise<string> {
  return (await sha256Hex(normalizeCaptionText(text))).slice(0, FINGERPRINT_LENGTH);
}

export interface OfficialContent {
  readonly summary: string;
  readonly outline: readonly {
    readonly title: string;
    readonly timestamp: number | null;
    readonly points: readonly { readonly timestamp: number | null; readonly content: string }[];
  }[];
}

const stamp = (value: number | null): string => (value === null ? "-" : millis(value));

/** 官方总结的摘要和提纲：按原有顺序逐行「层级|时间|规范化正文」，取 SHA-256 的前 16 位。顺序是内容的一部分。 */
export async function officialFingerprint({ summary, outline }: OfficialContent): Promise<string> {
  const lines = [`S|${normalizeCaptionText(summary)}`];
  for (const section of outline) {
    lines.push(`T|${stamp(section.timestamp)}|${normalizeCaptionText(section.title)}`);
    for (const point of section.points) lines.push(`P|${stamp(point.timestamp)}|${normalizeCaptionText(point.content)}`);
  }
  return (await sha256Hex(lines.join("\n"))).slice(0, FINGERPRINT_LENGTH);
}
