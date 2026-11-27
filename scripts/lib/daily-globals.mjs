// 在 Node 里直接读产品模块、装的又是日用包的脚本（YouTube 的端到端）第一个加载它：按日用构建的取值定义构建开关的全局常量，
// 和打出来的日用包一致。已经定义过的不动。
import { DAILY_FEATURES } from "../../src/shared/features.ts";
import { defineFeatureGlobals } from "./feature-globals.mjs";

defineFeatureGlobals(DAILY_FEATURES, { skipDefined: true });
