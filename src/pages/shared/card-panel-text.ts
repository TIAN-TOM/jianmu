// 卡片和侧边栏说的同一件事（同一个按钮、同一种状态）只在这里写一份，简体这份定下形状。繁体那份在 card-panel-text-hant.ts。
// 单开一个小模块，卡片只带上这几句，不带侧边栏自己的表。模块顶层只放字面量和函数。
import { byLang, inLang, type UiLang } from "./ui-lang.ts";
import { CARD_PANEL_HANT } from "./card-panel-text-hant.ts";

const CARD_PANEL_ZH = {
  openSettings: "打开设置",
  overview: {
    generate: "生成概览",
    regenerate: "重新生成",
    retryFailed: "补上缺的部分",
    failedParts: "有一部分没生成出来，可以只补这部分。",
    writingVerdict: "正在写一句话结论…",
  },
  ask: {
    label: "针对这个视频提问",
    answering: "正在字幕里找相关内容并回答…",
    truncated: "回答被截断了，可能不完整。",
    unsaved: "这条回答没能存进问答历史。",
  },
};

export type CardPanelText = typeof CARD_PANEL_ZH;

const CARD_PANEL_EN: CardPanelText = {
  openSettings: "Open settings",
  overview: {
    generate: "Generate overview",
    regenerate: "Regenerate",
    retryFailed: "Redo failed parts",
    failedParts: "Some parts didn't generate. You can redo just those.",
    writingVerdict: "Writing the one-line verdict…",
  },
  ask: {
    label: "Ask about this video",
    answering: "Searching the subtitles and answering…",
    truncated: "The answer was cut off and may be incomplete.",
    unsaved: "This answer couldn't be saved to your Q&A history.",
  },
};

/** 当前界面语言那份，组件渲染时调用。 */
export const cardPanelText = (): CardPanelText => byLang(CARD_PANEL_ZH, CARD_PANEL_EN, CARD_PANEL_HANT);

/** 指定语言那份。 */
export const cardPanelTextOf = (lang: UiLang): CardPanelText => inLang(lang, CARD_PANEL_ZH, CARD_PANEL_EN, CARD_PANEL_HANT);
