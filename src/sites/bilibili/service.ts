// 把 B 站的各块读取拼成站点服务，这里只拼装。
import type { SiteService } from "../types.ts";
import { createCaptions } from "./captions.ts";
import { createBiliHttp } from "./http.ts";
import { readOfficialSummary } from "./official-summary.ts";
import { bilibiliRules } from "./url.ts";
import { readVideoInfo } from "./video-info.ts";
import { readWatchLater } from "./watch-later.ts";

export interface BilibiliServiceDeps {
  readonly now?: () => number;
}

/** B 站有的几样能力都给齐；只给页面读取的站用的那项没有。 */
export type BilibiliService = Required<Omit<SiteService, "knownNoCaptions">>;

export function createBilibiliService(deps: BilibiliServiceDeps = {}): BilibiliService {
  const http = createBiliHttp(deps);
  return {
    rules: bilibiliRules,
    readVideoInfo: (ref, ctx, options) => readVideoInfo(http, ref, ctx, options),
    ...createCaptions(http, deps),
    readOfficialSummary: (info, ctx) => readOfficialSummary(http, info, ctx),
    readWatchLater: (ctx) => readWatchLater(http, ctx),
  };
}
