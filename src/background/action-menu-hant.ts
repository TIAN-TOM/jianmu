// 工具栏图标右键菜单的文字，繁体这份。形状由 action-menu.ts 里简体那份定，少一条、多一条，类型检查就报错。
// 模块顶层只放字面量。
import type { ActionMenuText } from "./action-menu.ts";

export const MENU_HANT: ActionMenuText = {
  triage: "稍後再看粗篩",
  inPageCard: "在影片右側顯示總結卡片",
  autoOverview: "打開影片就出結論（花 API 額度）",
};
