// 读视频的官方总结：摘要、提纲和附带的 AI 字幕，这份字幕用不用由取字幕服务决定。
import type { Cue, OfficialSummary, OutlineSection, SiteCtx, SiteResult, VideoInfo } from "../types.ts";
import { SUMMARY_URL, type BiliHttp } from "./http.ts";

interface RawPoint {
  readonly timestamp?: unknown;
  readonly content?: unknown;
}

interface RawSection {
  readonly title?: unknown;
  readonly timestamp?: unknown;
  readonly part_outline?: unknown;
}

interface RawLine {
  readonly content?: unknown;
  readonly start_timestamp?: unknown;
  readonly end_timestamp?: unknown;
}

interface SummaryData {
  readonly code?: unknown;
  readonly stid?: unknown;
  readonly model_result?: {
    readonly summary?: unknown;
    readonly outline?: unknown;
    readonly subtitle?: unknown;
  } | null;
}

export interface OfficialSummaryDeps {
  readonly timeoutMs?: number;
}

// 只算这一个请求，取密钥不计入：冷启动时取密钥常常慢，不该连累总结和附带的字幕。
const SUMMARY_TIMEOUT_MS = 8_000;

const plainText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

// 空值换成数字会变 0，跳到片头比没有落点更糟。
function secondsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function parseSection(section: RawSection | null): OutlineSection {
  const list: readonly (RawPoint | null)[] = Array.isArray(section?.part_outline) ? section.part_outline : [];
  const points = list
    .map((point) => ({ timestamp: secondsOrNull(point?.timestamp), content: plainText(point?.content) }))
    .filter((point) => point.content);
  // 分段缺时间时退到第一条带时间的要点，点击仍有落点。
  const timestamp = secondsOrNull(section?.timestamp) ?? points.find((point) => point.timestamp !== null)?.timestamp ?? null;
  return { title: plainText(section?.title), timestamp, points };
}

function parseOutline(raw: unknown): OutlineSection[] {
  const sections: readonly (RawSection | null)[] = Array.isArray(raw) ? raw : [];
  return sections.map(parseSection).filter((section) => section.title || section.points.length > 0);
}

// 摊平成和字幕正文一样的结构，缺开始时间的行丢掉，按开始时间排好。
function parseCues(raw: unknown): Cue[] {
  const parts: readonly ({ readonly part_subtitle?: unknown } | null)[] = Array.isArray(raw) ? raw : [];
  const cues: Cue[] = [];
  for (const part of parts) {
    const lines: readonly (RawLine | null)[] = Array.isArray(part?.part_subtitle) ? part.part_subtitle : [];
    for (const line of lines) {
      const text = plainText(line?.content);
      const start = secondsOrNull(line?.start_timestamp);
      if (!text || start === null) continue;
      const end = secondsOrNull(line?.end_timestamp);
      cues.push({ text, start, duration: end !== null && end > start ? end - start : 0 });
    }
  }
  return cues.sort((left, right) => left.start - right.start);
}

function summaryOf(status: OfficialSummary["status"], content: Partial<OfficialSummary> = {}): SiteResult<OfficialSummary> {
  return { ok: true, value: { status, summary: "", outline: [], cues: [], ...content } };
}

/** 把官方总结规整成四种内容状态：有总结、没有、排队生成中、平台不做。 */
export function parseOfficialSummary(data: unknown): SiteResult<OfficialSummary> {
  if (typeof data !== "object" || data === null) return { ok: false, code: "MALFORMED", detail: "no-summary-data" };
  const raw = data as SummaryData;
  const code = Number(raw.code);
  if (code === -1) return summaryOf("unsupported");
  if (code === 1) return summaryOf(String(raw.stid ?? "") === "0" ? "queued" : "none");
  if (code !== 0) {
    return { ok: false, code: "MALFORMED", detail: Number.isFinite(code) ? `summary-code:${code}` : "no-summary-code" };
  }
  const summary = plainText(raw.model_result?.summary);
  const outline = parseOutline(raw.model_result?.outline);
  const cues = parseCues(raw.model_result?.subtitle);
  return summaryOf(summary || outline.length > 0 ? "ok" : "none", { summary, outline, cues });
}

// 读当前视频的官方总结，登录门在请求出口里。
export async function readOfficialSummary(
  http: BiliHttp,
  info: VideoInfo,
  ctx: SiteCtx,
  deps: OfficialSummaryDeps = {},
): Promise<SiteResult<OfficialSummary>> {
  if (!info.mediaVersion) return { ok: false, code: "MALFORMED", detail: "no-media-version" };
  const params: Record<string, string> = { bvid: info.ref.videoId, cid: info.mediaVersion };
  if (info.channel) params["up_mid"] = info.channel.channelId;
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const data = await http.getData({ url: SUMMARY_URL, params, signed: true, timeoutMs }, ctx);
  return data.ok ? parseOfficialSummary(data.value) : data;
}
