// 校验设置时给用户看的提示的繁体那份，形状跟简体那份（settings-text.ts）一样。模块顶层只放字面量和函数。
import type { SettingsCheckText } from "./settings-text.ts";

export const CHECK_HANT: SettingsCheckText = {
  missingKey: "請填寫 API 金鑰（沒選記住金鑰時，瀏覽器重新啟動、簡幕更新後要重新填寫）。",
  missingModel: "請填寫模型名稱，或點選「取得模型清單」從裡面選。",
};
