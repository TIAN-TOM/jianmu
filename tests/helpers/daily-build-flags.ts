// 按开发者本人日用包的取值定义构建开关，给要看日用包行为的子进程用：node --import 先加载它，再读产品模块。
import { DAILY_FEATURES, FEATURE_GLOBALS, FEATURE_NAMES } from "../../src/shared/features.ts";

for (const name of FEATURE_NAMES) {
  Object.defineProperty(globalThis, FEATURE_GLOBALS[name], { value: DAILY_FEATURES[name], writable: false, configurable: false });
}
