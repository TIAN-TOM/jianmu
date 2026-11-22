// 沿用同意那一行和列表的繁体文案：只从 carried.tsx 引用，跟它一起只在构建开关 FEATURE_KEEP_CONSENT 打开时进包。
// 形状由 carried-text.ts 里简体那份定。模块顶层只放字面量。
import type { CarriedText } from "./carried-text.ts";

export const CARRIED_HANT: CarriedText = {
  notice: "說明更新了，多了幾項，照常使用",
  show: "看看多了什麼",
  label: "說明新增的內容",
  read: "在本機多讀取的",
  send: "多傳給模型服務的",
  done: "知道了",
};
