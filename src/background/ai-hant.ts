// 后台自己写的模型服务说明，繁体这份。形状由 ai.ts 里简体那份定，少一条、多一条或签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { WiringText } from "./ai.ts";

export const WIRING_HANT: WiringText = {
  addressChanged: "AI 還沒設定好：任務開始以後換了服務網址，請重新生成。",
  badAddress: "API 網址無效，請到設定頁檢查。",
  noPermission: (origin) => `擴充功能還沒有存取 ${origin} 的權限。請打開設定頁，點選「儲存並授權」。`,
  noKey: "請先在設定頁填寫 API 金鑰。",
};
