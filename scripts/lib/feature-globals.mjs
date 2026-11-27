// 在 Node 里把构建开关定义成只读的全局常量，取值由调用方给。四个入口（发行、日用、测试、测试用的日用）都调它。
import { FEATURE_GLOBALS, FEATURE_NAMES } from "../../src/shared/features.ts";

/**
 * @param {import("../../src/shared/features.ts").FeatureSet} features
 * @param {{ skipDefined?: boolean }} [options] skipDefined：已经定义过的不动；不打开时重复定义会抛错。
 */
export function defineFeatureGlobals(features, { skipDefined = false } = {}) {
  for (const name of FEATURE_NAMES) {
    const global = FEATURE_GLOBALS[name];
    if (skipDefined && global in globalThis) continue;
    Object.defineProperty(globalThis, global, { value: features[name], writable: false, configurable: false });
  }
}
