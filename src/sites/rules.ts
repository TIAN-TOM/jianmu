// 各站的地址规则，按平台取。
import type { Platform } from "../core/video-ref.ts";
import { bilibiliRules } from "./bilibili/url.ts";
import type { SiteRules } from "./types.ts";

export const siteRules: Readonly<Partial<Record<Platform, SiteRules>>> = {
  bilibili: bilibiliRules,
};
