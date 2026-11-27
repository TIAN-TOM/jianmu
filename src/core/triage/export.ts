// 粗筛的展示文字和 Markdown 清单导出。视频地址的前缀由调用方传入。固定文字按语言出，缺省中文；
// 标题、UP 主名、官方总结和模型写的结论原样写。
import { inLang, plural, type OutputLang } from "../output-lang.ts";
import { EXPORT_HANT } from "./export-hant.ts";
import { parseVideoKey } from "../video-ref.ts";
import { hasOfficialContent } from "./batch.ts";
import { GROUPS, groupItems, groupName, hasVerdict, type TriageVerdict, type VerdictMap } from "./groups.ts";
import type { OfficialMap, OfficialRecord, TriageItem } from "./state.ts";

export interface MarkdownInput {
  readonly items?: readonly TriageItem[];
  readonly official?: OfficialMap;
  readonly verdicts?: VerdictMap;
  readonly exportedAt?: number;
}

const EXPORT_ZH = {
  status: {
    ok: "有官方总结",
    none: "没有官方总结",
    queued: "B站现在没有这个视频的官方总结",
    unsupported: "B站不给这个视频做总结",
    "need-login": "要先在浏览器里登录 B站",
    failed: "请求失败，再点开始会重试",
  },
  unavailable: "视频已失效或暂时看不了，没有去取官方总结",
  notFetched: "还没取官方总结",
  withReason: (text: string, reason: string) => `${text}（${reason}）`,
  finished: "已看完",
  notStarted: "还没看",
  percent: (percent: number) => `（${percent}%）`,
  watchedTo: (at: string, percent: string) => `看到 ${at}${percent}`,
  fromOfficial: "基于 B站官方总结",
  fromOverview: "基于概览",
  heading: "# 稍后再看粗筛",
  exported: (at: string, count: number) => `导出于 ${at}，共 ${count} 个视频。`,
  group: (name: string, count: number) => `## ${name}（${count}）`,
  verdict: (summary: string, source: string) => `  - 结论：${summary}（${source}）`,
  value: (text: string) => `  - 核心价值：${text}`,
  reason: (text: string) => `  - 理由：${text}`,
  official: (text: string) => `  - 官方总结：${text}`,
  fileName: (stamp: string) => `简幕-稍后再看-${stamp}.md`,
};

export type ExportText = typeof EXPORT_ZH;

const EXPORT_EN: ExportText = {
  status: {
    ok: "Has an official summary",
    none: "No official summary",
    queued: "Bilibili has no official summary for this video yet",
    unsupported: "Bilibili doesn't summarise this video",
    "need-login": "Sign in to Bilibili in this browser first",
    failed: "Request failed. Click start again to retry",
  },
  unavailable: "Video is unavailable or can't be watched right now, so no official summary was fetched",
  notFetched: "Official summary not fetched yet",
  withReason: (text, reason) => `${text} (${reason})`,
  finished: "Finished",
  notStarted: "Not started",
  percent: (percent) => ` (${percent}%)`,
  watchedTo: (at, percent) => `Watched to ${at}${percent}`,
  fromOfficial: "based on the Bilibili official summary",
  fromOverview: "based on the overview",
  heading: "# Watch Later triage",
  exported: (at, count) => `Exported ${at}. ${plural(count, "video", "videos")} in total.`,
  group: (name, count) => `## ${name} (${count})`,
  verdict: (summary, source) => `  - Verdict: ${summary} (${source})`,
  value: (text) => `  - Core value: ${text}`,
  reason: (text) => `  - Reasoning: ${text}`,
  official: (text) => `  - Official summary: ${text}`,
  fileName: (stamp) => `jianmu-watch-later-${stamp}.md`,
};

const textOf = (lang: OutputLang): ExportText => inLang(lang, EXPORT_ZH, EXPORT_EN, EXPORT_HANT);

export function officialStatusText(
  record: OfficialRecord | null | undefined,
  item: TriageItem | null = null,
  lang: OutputLang = "zh",
): string {
  const t = textOf(lang);
  if (item && item.available === false) return t.unavailable;
  if (!record) return t.notFetched;
  if (record.status === "ok" && !hasOfficialContent(record)) return t.status.none;
  const known: Readonly<Record<string, string | undefined>> = t.status;
  const text = known[record.status as string] || t.status.failed;
  return record.status === "failed" && record.reason ? t.withReason(text, record.reason) : text;
}

export function videoUrl(videoId: string, baseUrl: string): string {
  return `${baseUrl}${videoId}`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

export function formatDuration(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours ? `${hours}:${pad2(minutes)}:${pad2(rest)}` : `${minutes}:${pad2(rest)}`;
}

// 本机时区的「2026-11-01 07:30」。
export function formatDateTime(timestamp: number): string {
  const date = new Date(Number(timestamp) || 0);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// 分 P 视频的进度只是当前那一 P 的位置，总时长却是全部分 P 的，不算百分比。
export function progressText(item: TriageItem | null | undefined, lang: OutputLang = "zh"): string {
  const t = textOf(lang);
  if (item?.finished) return t.finished;
  const progress = Math.floor(Number(item?.progress) || 0);
  if (progress <= 0) return t.notStarted;
  const duration = Math.floor(Number(item?.duration) || 0);
  const percent =
    duration > 0 && Number(item?.pageCount || 1) <= 1
      ? t.percent(Math.min(99, Math.round((progress / duration) * 100)))
      : "";
  return t.watchedTo(formatDuration(progress), percent);
}

function oneLine(text: string | undefined): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// 标题、摘要里的方括号和反引号之类会搅乱链接与列表，转义成字面量。
function escapeMarkdown(text: string | undefined): string {
  return oneLine(text).replace(/([\\`*_[\]<>])/g, "\\$1");
}

export function verdictSourceText(verdict: TriageVerdict | null | undefined, lang: OutputLang = "zh"): string {
  return verdict?.source === "official" ? textOf(lang).fromOfficial : textOf(lang).fromOverview;
}

/** 导出的文件名：按导出时刻（本机时区）编号。 */
export function exportFileName(exportedAt: number, lang: OutputLang = "zh"): string {
  return textOf(lang).fileName(formatDateTime(exportedAt).replace(/[-: ]/g, ""));
}

// 标题和链接用站点自己的视频编号；键认不出时原样用键。
function videoIdOf(item: TriageItem): string {
  return parseVideoKey(item.videoKey)?.videoId ?? item.videoKey;
}

/** 整份列表按判断分组导出成 Markdown 清单，空组不写。 */
export function toMarkdown(
  { items = [], official = {}, verdicts = {}, exportedAt = Date.now() }: MarkdownInput = {},
  videoBaseUrl: string,
  lang: OutputLang = "zh",
): string {
  const t = textOf(lang);
  const groups = groupItems(items, verdicts);
  const lines = [t.heading, "", t.exported(formatDateTime(exportedAt), items.length), ""];
  for (const key of GROUPS) {
    const members = groups[key];
    if (!members.length) continue;
    lines.push(t.group(groupName(key, lang), members.length), "");
    for (const item of members) {
      const meta = [item.ownerName, item.duration ? formatDuration(item.duration) : ""]
        .filter(Boolean)
        .map(escapeMarkdown)
        .join(" · ");
      const title = escapeMarkdown(item.title || videoIdOf(item));
      lines.push(`- [ ] [${title}](${videoUrl(videoIdOf(item), videoBaseUrl)})${meta ? ` · ${meta}` : ""}`);
      const verdict = verdicts[item.videoKey];
      if (hasVerdict(verdict)) {
        lines.push(t.verdict(escapeMarkdown(verdict.summary), verdictSourceText(verdict, lang)));
        if (oneLine(verdict.value)) lines.push(t.value(escapeMarkdown(verdict.value)));
        if (oneLine(verdict.reason)) lines.push(t.reason(escapeMarkdown(verdict.reason)));
        continue;
      }
      const record = official[item.videoKey];
      if (hasOfficialContent(record) && oneLine(record.summary)) {
        lines.push(t.official(escapeMarkdown(record.summary)));
      } else {
        lines.push(`  - ${officialStatusText(record, item, lang)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
