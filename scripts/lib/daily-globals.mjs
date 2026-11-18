// 在 Node 里直接读产品模块、装的又是日用包的脚本（YouTube 的端到端）第一个加载它：按日用构建的取值定义构建开关的全局常量，
// 和打出来的日用包一致。已经定义过的不动。
import { DAILY_FEATURES, FEATURE_GLOBALS, FEATURE_NAMES } from "../../src/shared/features.ts";

for (const name of FEATURE_NAMES) {
  const global = FEATURE_GLOBALS[name];
  if (global in globalThis) continue;
  Object.defineProperty(globalThis, global, { value: DAILY_FEATURES[name], writable: false, configurable: false });
}
