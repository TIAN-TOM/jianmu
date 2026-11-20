// 侧边栏取文案：组件渲染时用 panelText()，跟着界面语言重画；纯逻辑用 panelTextOf(lang)，语言由调用方传，缺省中文。
import { byLang, inLang, type UiLang } from "../shared/ui-lang.ts";
import { PANEL_EN } from "./text-en.ts";
import { PANEL_ZH, type PanelText } from "./text-zh.ts";

export type { PanelText } from "./text-zh.ts";

/** 当前界面语言那份文案，组件渲染时调用。 */
export const panelText = (): PanelText => byLang(PANEL_ZH, PANEL_EN);

/** 指定语言那份文案，纯逻辑用。 */
export const panelTextOf = (lang: UiLang = "zh"): PanelText => inLang(lang, PANEL_ZH, PANEL_EN);

/** 存笔记的结果是存上了（或者这个时间点已经有一条）：不管是按哪种语言写的。 */
export const noteStored = (result: string): boolean => [PANEL_ZH, PANEL_EN].some(({ notes }) => result === notes.saved || result === notes.duplicate);
