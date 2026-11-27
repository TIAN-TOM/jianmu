// 读视频信息，判断付费内容；确认是付费、充电专属的内容到这里就停，后面的读取都不发；确认不了的照读。
import type { VideoRef } from "../../core/video-ref.ts";
import { isRecord, stringOrEmpty } from "../../shared/guards.ts";
import type { SiteCtx, SiteResult, VideoInfo } from "../types.ts";
import { VIEW_URL, type BiliHttp } from "./http.ts";

interface PageData {
  readonly page?: unknown;
  readonly cid?: unknown;
  readonly part?: unknown;
  readonly duration?: unknown;
}

interface ViewData extends PageData {
  readonly aid?: unknown;
  readonly title?: unknown;
  readonly desc?: unknown;
  readonly owner?: { readonly name?: unknown; readonly mid?: unknown } | null;
  readonly pages?: unknown;
  readonly rights?: unknown;
  readonly is_upower_exclusive?: unknown;
}

export type PaidStatus = "paid" | "free" | "unknown";

const PAID_RIGHTS = ["pay", "ugc_pay", "arc_pay"] as const;

const pageNumber = (item: PageData, index: number): number => Number(item?.page) || index + 1;

// 付费标记只认有限数字和布尔值，别的写法都算读不懂。
const isMarker = (value: unknown): value is number | boolean =>
  typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
// 写成字符串、但明显是真的标记（"1"、"true" 这类）也算付费：确认不了时照读，宁可在这里多拦一点。
const looksTrue = (value: unknown): boolean =>
  (isMarker(value) && Boolean(value)) || (typeof value === "string" && /^\s*(true|-?[1-9]\d*)\s*$/i.test(value));

/**
 * 视频或稍后再看的一项：确认付费、确认免费，还是确认不了。
 * 任一付费标记为真（写成 "1"、"true" 的字符串也算）就算付费；四个标记都读到、写法都对、全是假才算免费；其余一律算确认不了。
 */
export function paidStatus(data: unknown): PaidStatus {
  if (!isRecord(data)) return "unknown";
  const rights = isRecord(data["rights"]) ? data["rights"] : {};
  const markers = [...PAID_RIGHTS.map((flag) => rights[flag]), data["is_upower_exclusive"]];
  if (markers.some(looksTrue)) return "paid";
  return markers.every(isMarker) ? "free" : "unknown";
}

/**
 * 把视频信息规整成内部结构。先核对返回的是不是请求的那个视频，再判断付费：确认是付费或充电专属的不往下读，
 * 确认免费和确认不了的照读；分 P 按身份里的序号取，不退回第 1 P。
 */
export function parseVideoInfo(data: unknown, ref: VideoRef): SiteResult<VideoInfo> {
  if (!isRecord(data)) return { ok: false, code: "MALFORMED", reach: "item", detail: "no-view-data" };
  // 对不上或看不出是哪个视频时整份不用，也不拿它的付费结论记到请求的视频上。
  if (data["bvid"] !== ref.videoId) return { ok: false, code: "MALFORMED", reach: "source", detail: "video-mismatch" };
  if (paidStatus(data) === "paid") return { ok: false, code: "UNPLAYABLE", detail: "paid" };

  const video: ViewData = data;
  const segment = ref.segment ?? 1;
  const pages: readonly PageData[] = Array.isArray(video.pages) ? video.pages : [];
  const page = pages.find((item, index) => pageNumber(item, index) === segment);
  if (pages.length > 0 ? !page : segment !== 1) return { ok: false, code: "SEGMENT_OUT_OF_RANGE" };

  // 选中的那一 P 缺编号时不退回视频本身的编号：那可能是另一 P 的。
  const cid = Number(page ? page.cid : video.cid) || 0;
  if (!cid) return { ok: false, code: "MALFORMED", reach: "item", detail: "no-cid" };

  const aid = Number(video.aid) || 0;
  const mid = Number(video.owner?.mid) || 0;
  return {
    ok: true,
    value: {
      ref, // 上面核对过，和返回的是同一个视频
      // 分 P 视频用分 P 标题，更贴近用户在页面上看到的。
      title: (pages.length > 1 && stringOrEmpty(page?.part)) || stringOrEmpty(video.title),
      author: stringOrEmpty(video.owner?.name),
      ...(mid ? { channel: { platform: "bilibili", channelId: String(mid) } as const } : {}),
      description: stringOrEmpty(video.desc),
      durationSec: Number(page?.duration ?? video.duration) || 0,
      mediaVersion: String(cid),
      ...(aid ? { siteRef: String(aid) } : {}),
      segments: pages.map((item, index) => ({
        index: pageNumber(item, index),
        title: stringOrEmpty(item?.part),
        durationSec: Number(item?.duration) || 0,
      })),
    },
  };
}

// 读当前视频的信息，登录门在请求出口里；登录可选时没登录也读。
export async function readVideoInfo(http: BiliHttp, ref: VideoRef, ctx: SiteCtx, options: { readonly loginOptional?: boolean } = {}): Promise<SiteResult<VideoInfo>> {
  const loginOptional = options.loginOptional === true ? { loginOptional: true } : {};
  const data = await http.getData({ url: VIEW_URL, params: { bvid: ref.videoId }, ...loginOptional }, ctx);
  return data.ok ? parseVideoInfo(data.value, ref) : data;
}
