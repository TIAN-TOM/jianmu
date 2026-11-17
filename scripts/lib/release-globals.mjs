// 在 Node 里直接读产品模块的脚本（发布脚本、端到端）第一个加载它：产品模块加载时就读构建开关的全局常量，
// 这里按发行构建的取值定义，和打出来的包一致。已经定义过的（单元测试先加载了测试构建的取值）不动。
import { FEATURE_GLOBALS, FEATURE_NAMES, RELEASE_FEATURES } from "../../src/shared/features.ts";

for (const name of FEATURE_NAMES) {
  const global = FEATURE_GLOBALS[name];
  if (global in globalThis) continue;
  Object.defineProperty(globalThis, global, { value: RELEASE_FEATURES[name], writable: false, configurable: false });
}
