// 裁剪探针的入口，写法和产品代码一样：分支只认裸的全局常量，开关保护的内容在别的模块里。
import { COMMENTS_PROBE, FRAME_EXPLAIN_PROBE, frameExplainRoute, KEEP_CONSENT_PROBE, YOUTUBE_OPEN_PANEL_PROBE, YOUTUBE_PLAYER_CAPTIONS_PROBE, YOUTUBE_PROBE } from "./gated.ts";

const routes: Record<string, () => string> = {};
if (FEATURE_FRAME_EXPLAIN) routes["frame"] = frameExplainRoute;

console.log([
  FEATURE_FRAME_EXPLAIN ? FRAME_EXPLAIN_PROBE : "off",
  FEATURE_YOUTUBE ? YOUTUBE_PROBE : "off",
  FEATURE_YOUTUBE_OPEN_PANEL ? YOUTUBE_OPEN_PANEL_PROBE : "off",
  FEATURE_YOUTUBE_CAPTION_CATCH ? YOUTUBE_PLAYER_CAPTIONS_PROBE : "off",
  FEATURE_KEEP_CONSENT ? KEEP_CONSENT_PROBE : "off",
  FEATURE_COMMENTS ? COMMENTS_PROBE : "off",
  Object.keys(routes),
]);
