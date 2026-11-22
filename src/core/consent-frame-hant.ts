// 解释当前画面那几条说明的繁体措辞：只从 consent.ts 的开关分支引用，跟 consent-frame.ts 一起只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包。
// 按条目的 kind:id 建表，和简体逐项对应。模块顶层只放字面量。
import type { HantFor } from "./consent.ts";
import type { FRAME_ACTIVATION_ITEMS, FRAME_DATA_ITEMS } from "./consent-frame.ts";

/** 首次启用说明的条目。 */
export const FRAME_ACTIVATION_HANT: HantFor<typeof FRAME_ACTIVATION_ITEMS> = {
  "read:current-frame": { text: "點選「解釋目前畫面」時，影片目前的一個影格，只用於這一次，不儲存" },
};

/** 数据说明的条目。 */
export const FRAME_DATA_HANT: HantFor<typeof FRAME_DATA_ITEMS> = {
  "category:current-frame": { text: "點選「解釋目前畫面」時影片目前的一個影格，只用於這一次，不儲存" },
  "purpose:frame-explain": {
    text: "解釋目前畫面",
    combined: "翻譯、整理字幕（補標點、改同音錯字）、概覽、一句話結論、選字解釋、筆記潤飾、問答、粗篩寫結論和解釋目前畫面",
  },
};
