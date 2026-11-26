// 评论区那几条说明的繁体措辞：只从 consent.ts 的开关分支引用，跟 consent-comments.ts 一起只在构建开关 FEATURE_COMMENTS 打开时进包。
// 按条目的 kind:id 建表，和简体逐项对应。模块顶层只放字面量。
import type { HantFor } from "./consent.ts";
import type { COMMENT_ACTIVATION_ITEMS, COMMENT_DATA_ITEMS } from "./consent-comments.ts";

/** 首次启用说明的条目。 */
export const COMMENT_ACTIVATION_HANT: HantFor<typeof COMMENT_ACTIVATION_ITEMS> = {
  "read:top-comments": {
    text: "產生概覽時，目前影片留言區的第一批熱門留言：只讀內文、按讚數和是否置頂，不讀暱稱和留言者的主頁。YouTube 上留言區還沒載入、分頁又在前景時，會替你把頁面捲到留言區一次，讀完捲回原處",
  },
};

/** 数据说明的条目。 */
export const COMMENT_DATA_HANT: HantFor<typeof COMMENT_DATA_ITEMS> = {
  "category:top-comments": {
    text: "產生概覽時目前影片的第一批熱門留言：內文和按讚數，不含暱稱；內文裡明顯帶聯絡方式的整則不傳送。開著「打開就出結論」時隨概覽自動傳送",
  },
};
