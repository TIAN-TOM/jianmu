// 各站的地址规则，按平台取。YouTube 只在构建开关打开时登记：关着时整站的地址规则都不进包，哪儿都认不出 YouTube 的页面。
import type { Platform } from "../core/video-ref.ts";
import { bilibiliRules } from "./bilibili/url.ts";
import type { SiteRules } from "./types.ts";
import { youtubeRules } from "./youtube/url.ts";

export const siteRules: Readonly<Partial<Record<Platform, SiteRules>>> = FEATURE_YOUTUBE
  ? { bilibili: bilibiliRules, youtube: youtubeRules }
  : { bilibili: bilibiliRules };
