// YouTube 的地址规则：只认观看页，从地址认视频，生成规范链接，另给授权和注册内容脚本用的站点匹配规则。只算字符串。
// 只从 rules.ts 的构建开关分支引用，顶层只放字面量和函数，开关关着时整个模块不进包。
import type { VideoRef } from "../../core/video-ref.ts";
import type { SiteRules } from "../types.ts";

const WATCH_HOST = "www.youtube.com";
const WATCH_PATH = "/watch";
// 和视频身份的规则一致：编号来自用户正在看的页面，只校验字符集和长度上限。
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
// 授权只要这一个来源；注册的内容脚本也覆盖站内的其他页面，因为站内跳转不重新加载页面。
const SITE_PATTERN = "https://www.youtube.com/*";

// 按主机名认，只认默认端口、不带账号的 https 地址：外站把站名写进路径或参数不算。
function isWatchPage(parsed: URL): boolean {
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === WATCH_HOST &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === WATCH_PATH
  );
}

/** 只认观看页上唯一一个合法编号。起播时间、播放列表、追踪参数不进身份；Shorts、嵌入页这类页面不支持。 */
export function parseWatchUrl(url: string): VideoRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isWatchPage(parsed)) return null;
  const ids = parsed.searchParams.getAll("v");
  const [videoId] = ids;
  return ids.length === 1 && videoId !== undefined && VIDEO_ID.test(videoId) ? { platform: "youtube", videoId } : null;
}

/** 只从身份生成，起播时间不足一秒时不写时间。 */
export function canonicalUrl(ref: VideoRef, atSec?: number): string {
  if (ref.platform !== "youtube" || ref.segment !== undefined || !VIDEO_ID.test(ref.videoId)) {
    throw new RangeError(`不是有效的 YouTube 视频身份：${ref.videoId}`);
  }
  const url = new URL(`https://www.youtube.com/watch?v=${ref.videoId}`);
  const seconds = Number(atSec);
  const start = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (start > 0) url.searchParams.set("t", `${start}s`);
  return url.toString();
}

export const youtubeRules: SiteRules = {
  platform: "youtube",
  optionalPermission: true,
  parseWatchUrl,
  canonicalUrl,
  permissionOrigins: [SITE_PATTERN],
  scriptMatches: [SITE_PATTERN],
};
