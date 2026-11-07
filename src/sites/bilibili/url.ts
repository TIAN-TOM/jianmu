// B 站的地址解析：av 号换 BV 号，从地址认视频，生成规范链接。只算字符串和数字。
import type { VideoRef } from "../../core/video-ref.ts";
import type { SiteRules } from "../types.ts";

export const AV_XOR_CODE = 23442827791579n;
export const BV_ALPHABET = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";

const AV_LIMIT = 1n << 51n;
const BV_TEMPLATE = "BV1000000000";

// 路径前面可能多一段语言。
const AV_PATH = /^\/(?:[a-z]{2,3}(?:-[A-Za-z]{2,4})?\/)?video\/av(\d+)(?:\/|$)/i;
const BV_PATH = /^\/(?:[a-z]{2,3}(?:-[A-Za-z]{2,4})?\/)?(?:video|list)\/(?:[^/]*\/)?(BV[0-9A-Za-z]{10})/;
const LIST_PATH = /^\/(?:[a-z]{2,3}(?:-[A-Za-z]{2,4})?\/)?list(?:\/|$)/;
const BV_IN_TEXT = /BV[0-9A-Za-z]{10}/;
const BV_ONLY = /^BV[0-9A-Za-z]{10}$/;

function swap(chars: string[], left: number, right: number): void {
  const moved = chars[left] ?? "";
  chars[left] = chars[right] ?? "";
  chars[right] = moved;
}

/** av 号换 BV 号，纯本地计算。不是有效的 av 号时返回 null。 */
export function avToBv(aid: string | number | bigint): string | null {
  let value: bigint;
  try {
    value = BigInt(aid);
  } catch {
    return null;
  }
  if (value <= 0n || value >= AV_LIMIT) return null;
  const chars = BV_TEMPLATE.split("");
  let rest = (AV_LIMIT | value) ^ AV_XOR_CODE;
  for (let index = chars.length - 1; rest > 0n; index -= 1) {
    chars[index] = BV_ALPHABET.charAt(Number(rest % 58n));
    rest /= 58n;
  }
  swap(chars, 3, 9);
  swap(chars, 4, 7);
  return chars.join("");
}

/** 文本里的第一个 BV 号，认不认这个来源由调用方定。 */
export function parseBvid(input: string | null | undefined): string | null {
  return BV_IN_TEXT.exec(String(input || ""))?.[0] ?? null;
}

function bvFromQuery(parsed: URL): string | null {
  if (!LIST_PATH.test(parsed.pathname)) return null;
  const value = parsed.searchParams.get("bvid") ?? "";
  return BV_ONLY.test(value) ? value : null;
}

function bvFromAvPath(pathname: string): string | null {
  const digits = AV_PATH.exec(pathname)?.[1];
  return digits === undefined ? null : avToBv(digits);
}

function segmentOf(parsed: URL): number {
  const text = parsed.searchParams.get("p") ?? "";
  const segment = /^\d+$/.test(text) ? Number(text) : 0;
  return Number.isSafeInteger(segment) && segment > 0 ? segment : 1;
}

/** 从地址里拆出视频，不看主机。追踪参数和起播时间不进身份，分 P 不合法时算第 1 P。 */
export function videoFromUrl(parsed: URL): VideoRef | null {
  const videoId = BV_PATH.exec(parsed.pathname)?.[1] ?? bvFromQuery(parsed) ?? bvFromAvPath(parsed.pathname);
  return videoId ? { platform: "bilibili", videoId, segment: segmentOf(parsed) } : null;
}

// 按主机名认 B 站：外站把域名写进路径或参数不算。
function isBilibiliUrl(parsed: URL): boolean {
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return parsed.hostname === "bilibili.com" || parsed.hostname.endsWith(".bilibili.com");
}

export function parseWatchUrl(url: string): VideoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return isBilibiliUrl(parsed) ? videoFromUrl(parsed) : null;
}

/** 第 1 P 不写分 P 参数，起播时间不足一秒时不写时间。 */
export function canonicalUrl(ref: VideoRef, atSec?: number): string {
  if (!BV_ONLY.test(ref.videoId)) throw new Error("无效的 BV 号");
  const url = new URL(`https://www.bilibili.com/video/${ref.videoId}`);
  const segment = ref.segment ?? 1;
  if (segment > 1) url.searchParams.set("p", String(segment));
  const start = Math.max(0, Math.floor(Number(atSec) || 0));
  if (start > 0) url.searchParams.set("t", String(start));
  return url.toString();
}

export const bilibiliRules: SiteRules = {
  platform: "bilibili",
  optionalPermission: false,
  parseWatchUrl,
  canonicalUrl,
};
