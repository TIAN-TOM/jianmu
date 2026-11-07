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

export function createBilibiliService(deps: BilibiliServiceDeps = {}): Required<SiteService> {
  const http = createBiliHttp(deps);
  return {
    rules: bilibiliRules,
    readVideoInfo: (ref, ctx) => readVideoInfo(http, ref, ctx),
    ...createCaptions(http, deps),
    readOfficialSummary: (info, ctx) => readOfficialSummary(http, info, ctx),
    readWatchLater: (ctx) => readWatchLater(http, ctx),
  };
}
