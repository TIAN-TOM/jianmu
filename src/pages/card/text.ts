// 卡片取文案：组件渲染时用 cardText()，跟着界面语言重画；纯逻辑用 cardTextOf(lang)，语言由调用方传，缺省中文。
import { byLang, inLang, type UiLang } from "../shared/ui-lang.ts";
import { CARD_EN } from "./text-en.ts";
import { CARD_ZH, type CardText } from "./text-zh.ts";

export type { CardText } from "./text-zh.ts";

/** 当前界面语言那份文案，组件渲染时调用。 */
export const cardText = (): CardText => byLang(CARD_ZH, CARD_EN);

/** 指定语言那份文案，纯逻辑用。 */
export const cardTextOf = (lang: UiLang = "zh"): CardText => inLang(lang, CARD_ZH, CARD_EN);
