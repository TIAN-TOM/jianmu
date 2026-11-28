// 卡片和侧边栏共用的那几句，繁体这份：只从 card-panel-text.ts 引用。模块顶层只放字面量和函数。
import type { CardPanelText } from "./card-panel-text.ts";

export const CARD_PANEL_HANT: CardPanelText = {
  openSettings: "打開設定",
  overview: {
    generate: "生成概覽",
    regenerate: "重新生成",
    retryFailed: "補上缺的部分",
    failedParts: "有一部分沒有生成出來，可以只補這部分。",
    writingVerdict: "正在寫一句話結論…",
  },
  ask: {
    label: "針對這部影片提問",
    answering: "正在字幕裡找相關內容並回答…",
    truncated: "回答被截斷了，可能不完整。",
    unsaved: "這則回答沒能存進問答紀錄。",
  },
};
