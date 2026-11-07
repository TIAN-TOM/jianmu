// 读用户自己的稍后再看列表，规整成粗筛用的条目。
import { videoKey } from "../../core/video-ref.ts";
import type { SiteCtx, SiteResult, WatchLaterItem, WatchLaterList } from "../types.ts";
import { WATCH_LATER_URL, type BiliHttp } from "./http.ts";
import { parseBvid } from "./url.ts";
import { paidStatus } from "./video-info.ts";

interface RawItem {
  readonly bvid?: unknown;
  readonly cid?: unknown;
  readonly page?: { readonly cid?: unknown } | null;
  readonly title?: unknown;
  readonly pic?: unknown;
  readonly owner?: { readonly name?: unknown; readonly mid?: unknown } | null;
  readonly desc?: unknown;
  readonly duration?: unknown;
  readonly progress?: unknown;
  readonly videos?: unknown;
  readonly count?: unknown;
  readonly add_at?: unknown;
  readonly state?: unknown;
}

interface WatchLaterData {
  readonly count?: unknown;
  readonly list?: unknown;
}

export interface WatchLaterDeps {
  readonly timeoutMs?: number;
}

const WATCH_LATER_TIMEOUT_MS = 15_000;
const WATCHED_TO_END = -1;

const plainText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function positiveInt(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

// 只收 http(s) 和协议相对的地址，统一成 https，别的协议不放进图片地址。
function httpsImageUrl(value: unknown): string {
  const raw = plainText(value);
  if (!raw) return "";
  const absolute = raw.startsWith("//") ? `https:${raw}` : raw.replace(/^http:\/\//i, "https://");
  try {
    const url = new URL(absolute);
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** 把稍后再看列表的一项规整成内部结构，缺视频编号的项返回 null。多 P 视频按第 1 P 记。 */
export function parseWatchLaterItem(raw: RawItem | null): WatchLaterItem | null {
  if (typeof raw?.bvid !== "string" || parseBvid(raw.bvid) !== raw.bvid) return null;
  const cid = positiveInt(raw.cid) || positiveInt(raw.page?.cid);
  const mid = positiveInt(raw.owner?.mid);
  const paid = paidStatus(raw);
  return {
    videoKey: videoKey({ platform: "bilibili", videoId: raw.bvid, segment: 1 }),
    title: plainText(raw.title),
    ownerName: plainText(raw.owner?.name),
    ...(mid ? { channel: { platform: "bilibili", channelId: String(mid) } as const } : {}),
    ...(cid ? { mediaVersion: String(cid) } : {}),
    duration: positiveInt(raw.duration),
    progress: positiveInt(raw.progress),
    finished: Number(raw.progress) === WATCHED_TO_END,
    pageCount: positiveInt(raw.videos) || positiveInt(raw.count) || 1,
    // 没给状态时算能看：宁可多问一次总结，也不把好视频标成失效。
    available: paid !== "paid" && !(Number(raw.state) < 0),
    cover: httpsImageUrl(raw.pic),
    description: plainText(raw.desc),
    addedAt: positiveInt(raw.add_at),
    // 确认不了是否付费时仍算能看，但不算判断过：读官方总结前要先过视频信息。
    paidChecked: paid !== "unknown",
  };
}

/** 把列表规整成内部结构。没有列表算空的；缺视频编号和重复的项丢掉，计入 dropped。 */
export function parseWatchLater(data: unknown): SiteResult<WatchLaterList> {
  if (typeof data !== "object" || data === null) return { ok: false, code: "MALFORMED", detail: "no-list-data" };
  const { count, list } = data as WatchLaterData;
  const rawList: readonly (RawItem | null)[] = Array.isArray(list) ? list : [];
  const items = new Map<string, WatchLaterItem>();
  for (const raw of rawList) {
    const item = parseWatchLaterItem(raw);
    if (item && !items.has(item.videoKey)) items.set(item.videoKey, item);
  }
  return {
    ok: true,
    value: {
      total: positiveInt(count) || rawList.length,
      dropped: rawList.length - items.size,
      items: [...items.values()],
    },
  };
}

// 读稍后再看列表，只读不带参数，登录门在请求出口里。
export async function readWatchLater(
  http: BiliHttp,
  ctx: SiteCtx,
  deps: WatchLaterDeps = {},
): Promise<SiteResult<WatchLaterList>> {
  const timeoutMs = deps.timeoutMs ?? WATCH_LATER_TIMEOUT_MS;
  const data = await http.getData({ url: WATCH_LATER_URL, timeoutMs }, ctx);
  return data.ok ? parseWatchLater(data.value) : data;
}
