// 共用组件取文案：组件渲染时用 sharedText()，跟着界面语言重画；纯逻辑用 sharedTextOf(lang)，语言由调用方传，缺省中文。
import { byLang, inLang, type UiLang } from "./ui-lang.ts";
import { SHARED_EN } from "./text-en.ts";
import { SHARED_ZH, type SharedText } from "./text-zh.ts";

export type { SharedText } from "./text-zh.ts";

/** 当前界面语言那份文案，组件渲染时调用。 */
export const sharedText = (): SharedText => byLang(SHARED_ZH, SHARED_EN);

/** 指定语言那份文案，纯逻辑用。 */
export const sharedTextOf = (lang: UiLang = "zh"): SharedText => inLang(lang, SHARED_ZH, SHARED_EN);
