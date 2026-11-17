// Node 跑测试时把构建开关定义成全局常量，取值和测试构建一致。npm test 用 --import 先加载它，单跑一个测试文件也要带上。
// 定义成只读：要看开关关着时的行为，把取值当参数传进去，不改全局常量。
import { FEATURE_GLOBALS, FEATURE_NAMES, TEST_BUILD_FEATURES } from "../../src/shared/features.ts";

for (const name of FEATURE_NAMES) {
  Object.defineProperty(globalThis, FEATURE_GLOBALS[name], { value: TEST_BUILD_FEATURES[name], writable: false, configurable: false });
}
