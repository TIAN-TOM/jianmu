// 按开发者本人日用包的取值定义构建开关，给要看日用包行为的子进程用：node --import 先加载它，再读产品模块。
import { defineFeatureGlobals } from "../../scripts/lib/feature-globals.mjs";
import { DAILY_FEATURES } from "../../src/shared/features.ts";

defineFeatureGlobals(DAILY_FEATURES);
