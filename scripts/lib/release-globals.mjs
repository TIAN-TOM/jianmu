// 在 Node 里直接读产品模块的脚本（发布脚本、端到端）第一个加载它：产品模块加载时就读构建开关的全局常量，
// 这里按发行构建的取值定义，和打出来的包一致。已经定义过的（单元测试先加载了测试构建的取值）不动。
import { RELEASE_FEATURES } from "../../src/shared/features.ts";
import { defineFeatureGlobals } from "./feature-globals.mjs";

defineFeatureGlobals(RELEASE_FEATURES, { skipDefined: true });
