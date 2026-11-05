// 粗筛的展示文字和 Markdown 清单导出。视频地址的前缀由调用方传入。
import { parseVideoKey } from "../video-ref.ts";
import { hasOfficialContent } from "./batch.ts";
import { GROUPS, groupItems, hasVerdict, type TriageVerdict, type VerdictMap } from "./groups.ts";
import type { OfficialMap, OfficialRecord, TriageItem } from "./state.ts";

export interface MarkdownInput {
  readonly items?: readonly TriageItem[];
  readonly official?: OfficialMap;
  readonly verdicts?: VerdictMap;
  readonly exportedAt?: number;
}

export const OFFICIAL_STATUS_TEXT = Object.freeze({
  ok: "有官方总结",
  none: "没有官方总结",
  queued: "B站还在生成总结，过几分钟再点开始",
  unsupported: "B站不给这个视频做总结",
  "need-login": "要先在浏览器里登录 B站",
  failed: "请求失败，再点开始会重试",
});

export function officialStatusText(
  record: OfficialRecord | null | undefined,
  item: TriageItem | null = null,
): string {
  if (item && item.available === false) return "视频已失效或暂时看不了，没有去取官方总结";
  if (!record) return "还没取官方总结";
  if (record.status === "ok" && !hasOfficialContent(record)) return OFFICIAL_STATUS_TEXT.none;
  const known: Readonly<Record<string, string | undefined>> = OFFICIAL_STATUS_TEXT;
  const text = known[record.status as string] || OFFICIAL_STATUS_TEXT.failed;
  return record.status === "failed" && record.reason ? `${text}（${record.reason}）` : text;
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
export function progressText(item: TriageItem | null | undefined): string {
  if (item?.finished) return "已看完";
  const progress = Math.floor(Number(item?.progress) || 0);
  if (progress <= 0) return "还没看";
  const duration = Math.floor(Number(item?.duration) || 0);
  const percent =
    duration > 0 && Number(item?.pageCount || 1) <= 1
      ? `（${Math.min(99, Math.round((progress / duration) * 100))}%）`
      : "";
  return `看到 ${formatDuration(progress)}${percent}`;
}

function oneLine(text: string | undefined): string {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// 标题、摘要里的方括号和反引号之类会搅乱链接与列表，转义成字面量。
function escapeMarkdown(text: string | undefined): string {
  return oneLine(text).replace(/([\\`*_[\]<>])/g, "\\$1");
}

export function verdictSourceText(verdict: TriageVerdict | null | undefined): string {
  return verdict?.source === "official" ? "基于 B站官方总结" : "基于概览";
}

// 标题和链接用站点自己的视频编号；键认不出时原样用键。
function videoIdOf(item: TriageItem): string {
  return parseVideoKey(item.videoKey)?.videoId ?? item.videoKey;
}

/** 整份列表按判断分组导出成 Markdown 清单，空组不写。 */
export function toMarkdown(
  { items = [], official = {}, verdicts = {}, exportedAt = Date.now() }: MarkdownInput = {},
  videoBaseUrl: string,
): string {
  const groups = groupItems(items, verdicts);
  const lines = [
    "# 稍后再看粗筛",
    "",
    `导出于 ${formatDateTime(exportedAt)}，共 ${items.length} 个视频。`,
    "",
  ];
  for (const group of GROUPS) {
    const members = groups[group.key];
    if (!members.length) continue;
    lines.push(`## ${group.label}（${members.length}）`, "");
    for (const item of members) {
      const meta = [item.ownerName, item.duration ? formatDuration(item.duration) : ""]
        .filter(Boolean)
        .map(escapeMarkdown)
        .join(" · ");
      const title = escapeMarkdown(item.title || videoIdOf(item));
      lines.push(`- [ ] [${title}](${videoUrl(videoIdOf(item), videoBaseUrl)})${meta ? ` · ${meta}` : ""}`);
      const verdict = verdicts[item.videoKey];
      if (hasVerdict(verdict)) {
        lines.push(`  - 结论：${escapeMarkdown(verdict.summary)}（${verdictSourceText(verdict)}）`);
        if (oneLine(verdict.value)) lines.push(`  - 核心价值：${escapeMarkdown(verdict.value)}`);
        if (oneLine(verdict.reason)) lines.push(`  - 理由：${escapeMarkdown(verdict.reason)}`);
        continue;
      }
      const record = official[item.videoKey];
      if (hasOfficialContent(record) && oneLine(record.summary)) {
        lines.push(`  - 官方总结：${escapeMarkdown(record.summary)}`);
      } else {
        lines.push(`  - ${officialStatusText(record, item)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
