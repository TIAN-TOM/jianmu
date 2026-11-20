// 设置页取文案：组件渲染时用 optionsText()，跟着界面语言重画；纯逻辑用 textOf(lang)，语言由调用方传，缺省中文。
// 按功能选模型的显示名经 slotLabel 取：画面分析那一项的名字在开关模块里，只从开关分支引用。
import type { FeatureSlotId } from "../../shared/settings-schema.ts";
import { byLang, inLang, type UiLang } from "../shared/ui-lang.ts";
import { frameSlotLabel } from "./frame-text.ts";
import { OPTIONS_EN } from "./text-en.ts";
import { OPTIONS_ZH, type OptionsText } from "./text-zh.ts";

export type { OptionsText } from "./text-zh.ts";

/** 当前界面语言那份文案，组件渲染时调用。 */
export const optionsText = (): OptionsText => byLang(OPTIONS_ZH, OPTIONS_EN);

/** 指定语言那份文案，纯逻辑用。 */
export const textOf = (lang: UiLang = "zh"): OptionsText => inLang(lang, OPTIONS_ZH, OPTIONS_EN);

/** 一项功能在设置页上的名字。 */
export const slotLabel = (id: FeatureSlotId, lang: UiLang = "zh"): string =>
  id === "frame" ? (FEATURE_FRAME_EXPLAIN ? frameSlotLabel(lang) : id) : textOf(lang).ai.slots[id];
