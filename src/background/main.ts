// 后台入口。骨架阶段只让工具栏图标打开侧边栏，路由和服务在后续步骤加入。
// 服务接上之前也让提示词进包：缺文件时构建就失败。
import "./prompts.ts";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
    console.error("设置侧边栏的打开方式失败", error);
  });
});
