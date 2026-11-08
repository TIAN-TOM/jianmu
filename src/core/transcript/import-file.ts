// 用户导入的字幕文件：SRT 和 WebVTT 解析成字幕条目 { start, duration, text }（秒）。
// 只认这两种纯文本格式。宽容处理常见的脏数据：UTF-8 BOM、Windows 换行、序号缺失或不连续、
// 逗号或点号的毫秒、只写分秒的时间戳、行内的 HTML 和 VTT 标签、ASS 风格的 {\an8} 定位码。
// 解析不出任何条目时返回错误码，交给界面说明原因。

export type SubtitleFormat = "srt" | "vtt";
export type SubtitleFileError = "EMPTY_FILE" | "FILE_TOO_LARGE" | "TOO_MANY_ENTRIES" | "NO_CUES";

export interface ImportedEntry {
  text: string;
  start: number;
  duration: number;
}

export type SubtitleFileResult =
  | { ok: true; entries: ImportedEntry[]; format: SubtitleFormat }
  | { ok: false; error: SubtitleFileError; message: string };

// 侧边栏读文件前和后台解析时都核对，免得误选一个视频文件把内存撑爆。普通字幕几十到几百 KB。
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ENTRIES = 20000;
export const EXTENSIONS: readonly string[] = [".srt", ".vtt"];

// 00:01:02,345、00:01:02.345、01:02.345（VTT 允许省略小时）、1:02:03,4
const TIMESTAMP = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/;
const CUE_TIMING = new RegExp(`^\\s*(${TIMESTAMP.source})\\s*-->\\s*(${TIMESTAMP.source})`);

function toSeconds(text: string): number | null {
  const match = TIMESTAMP.exec(text);
  if (!match) return null;
  const [, hours = "0", minutes, seconds, fraction = "0"] = match;
  const millis = Number(fraction.padEnd(3, "0").slice(0, 3));
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + millis / 1000;
  return Number.isFinite(total) ? total : null;
}

// 删掉 open…close 之间的内容（含两头）。没有收尾的 open 原样留下，而且后面不会再有收尾，
// 剩下的一并原样留下：用正则 /<[^>]*>/ 时，一长串不收尾的 < 每个都要扫到结尾，2 MB 的
// 特制文件能把后台卡住很久，这里每个字符只看一次。
function stripDelimited(text: string, open: string, close: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(open, index);
    if (start < 0) break;
    const end = text.indexOf(close, start + open.length);
    if (end < 0) break;
    out += text.slice(index, start);
    index = end + close.length;
  }
  return out + text.slice(index);
}

function cleanText(lines: readonly string[]): string {
  return stripDelimited(stripDelimited(lines.join(" "), "{\\", "}"), "<", ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 按空行切块。只有空格、制表符的行也算空行：不少字幕工具会在分隔行留下空白，
// 不认的话相邻几条会并成一块，后面那几条的序号和时间都成了第一条的正文。
function splitBlocks(source: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of source.split("\n")) {
    if (line.trim()) {
      current.push(line);
    } else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/**
 * text：文件内容。两种格式共用一套解析：按空行切块，块里找「开始 --> 结束」那一行，后面的行是正文。
 * VTT 的 NOTE、STYLE、REGION 块和文件头没有时间行，自然被跳过。
 */
export function parseSubtitleFile(text: unknown, fileName: string = ""): SubtitleFileResult {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "EMPTY_FILE", message: "字幕文件是空的。" };
  }
  if (text.length > MAX_FILE_BYTES) {
    return { ok: false, error: "FILE_TOO_LARGE", message: "字幕文件太大了（超过 2 MB），不像是字幕。" };
  }
  const source = text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  const format: SubtitleFormat = /^WEBVTT\b/.test(source) || /\.vtt$/i.test(fileName) ? "vtt" : "srt";
  const entries: ImportedEntry[] = [];
  for (const lines of splitBlocks(source)) {
    const timingIndex = lines.findIndex((line) => CUE_TIMING.test(line));
    const timingLine = lines[timingIndex];
    if (timingLine === undefined) continue;
    const [startText = "", endText = ""] = timingLine.split("-->");
    const start = toSeconds(startText);
    const end = toSeconds(endText);
    if (start === null || end === null) continue;
    const body = cleanText(lines.slice(timingIndex + 1));
    if (!body) continue;
    entries.push({ text: body, start, duration: Math.max(0, end - start) });
    if (entries.length > MAX_ENTRIES) {
      return { ok: false, error: "TOO_MANY_ENTRIES", message: "字幕条目太多了，不像是一个视频的字幕。" };
    }
  }
  if (!entries.length) {
    return {
      ok: false,
      error: "NO_CUES",
      message: "没有从这个文件里读出字幕。只支持 SRT 和 VTT 格式的文本字幕。",
    };
  }
  entries.sort((a, b) => a.start - b.start);
  return { ok: true, entries, format };
}

export function isSupportedFileName(name: string | null | undefined): boolean {
  const lower = String(name || "").toLowerCase();
  return EXTENSIONS.some((extension) => lower.endsWith(extension));
}
