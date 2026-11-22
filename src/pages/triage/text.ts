// 粗筛页取文案：组件渲染时用 triageText()，跟着界面语言重画；纯逻辑用 triageTextOf(lang)，语言由调用方传，缺省简体。
import { byLang, inLang, type UiLang } from "../shared/ui-lang.ts";
import { TRIAGE_EN } from "./text-en.ts";
import { TRIAGE_HANT } from "./text-hant.ts";
import { TRIAGE_ZH, type TriageText } from "./text-zh.ts";

export type { TriageText } from "./text-zh.ts";

/** 当前界面语言那份文案，组件渲染时调用。 */
export const triageText = (): TriageText => byLang(TRIAGE_ZH, TRIAGE_EN, TRIAGE_HANT);

/** 指定语言那份文案，纯逻辑用。 */
export const triageTextOf = (lang: UiLang = "zh"): TriageText => inLang(lang, TRIAGE_ZH, TRIAGE_EN, TRIAGE_HANT);
