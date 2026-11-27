// 各站的地址规则，按平台取。YouTube 只在构建开关打开时登记：关着时整站的地址规则都不进包，哪儿都认不出 YouTube 的页面。
import type { Platform, VideoRef } from "../core/video-ref.ts";
import { bilibiliRules } from "./bilibili/url.ts";
import type { SiteRules } from "./types.ts";
import { youtubeRules } from "./youtube/url.ts";

export const siteRules: Readonly<Partial<Record<Platform, SiteRules>>> = FEATURE_YOUTUBE
  ? { bilibili: bilibiliRules, youtube: youtubeRules }
  : { bilibili: bilibiliRules };

/**
 * 这个平台的字幕是不是要用户点了才经视频页读。调用方只经这里问，不按站名分支。
 * 没登记的平台按经页面读算：后台不为它自己去读，这是最保守的答案。rules 不传时用全局的规则表，测试可以注入替身。
 */
export function captionsInPage(platform: Platform, rules: readonly SiteRules[] = Object.values(siteRules)): boolean {
  return rules.find((rule) => rule.platform === platform)?.captions !== "service";
}

/** 按各站的地址规则认播放页上的视频，第一条认得出的规则说了算；认不出是 null。rules 不传时用全局的规则表。 */
export function watchRefOf(url: string, rules: readonly SiteRules[] = Object.values(siteRules)): VideoRef | null {
  for (const rule of rules) {
    const ref = rule.parseWatchUrl(url);
    if (ref) return ref;
  }
  return null;
}
