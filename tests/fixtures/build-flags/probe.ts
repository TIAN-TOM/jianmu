// 裁剪探针的入口，写法和产品代码一样：分支只认裸的全局常量，开关保护的内容在别的模块里。
import { FRAME_EXPLAIN_PROBE, frameExplainRoute, YOUTUBE_OPEN_PANEL_PROBE, YOUTUBE_PROBE, YOUTUBE_SWITCH_LANG_PROBE } from "./gated.ts";

const routes: Record<string, () => string> = {};
if (FEATURE_FRAME_EXPLAIN) routes["frame"] = frameExplainRoute;

console.log([
  FEATURE_FRAME_EXPLAIN ? FRAME_EXPLAIN_PROBE : "off",
  FEATURE_YOUTUBE ? YOUTUBE_PROBE : "off",
  FEATURE_YOUTUBE_OPEN_PANEL ? YOUTUBE_OPEN_PANEL_PROBE : "off",
  FEATURE_YOUTUBE_SWITCH_LANG ? YOUTUBE_SWITCH_LANG_PROBE : "off",
  Object.keys(routes),
]);
