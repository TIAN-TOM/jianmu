// 任务进度和任务收尾的那句话，繁体这份。形状由简体那份（progress-text.ts）定，少一条、多一条或签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { ProgressText } from "./progress-text.ts";

export const PROGRESS_HANT: ProgressText = {
  preparing: "正在準備…",
  qaSearching: "正在搜尋相關內容…",
  qaAnswering: "正在整理回答…",
  qaShrinking: "字幕太長，這個模型裝不下，縮小範圍再問一次…",
  translateBatch: (done, total) => `正在處理第 ${done}/${total} 批`,
  translateRetry: (count) => `正在重試 ${count} 批`,
  chunkRetry: (count) => `正在重試 ${count} 個失敗分塊`,
  verdict: "正在寫一句話結論…",
  overviewChunk: (done, total) => `正在生成第 ${done}/${total} 塊`,
  merging: "正在合併概覽…",
  refillChunk: (done, total) => `正在補第 ${done}/${total} 個失敗塊`,
  refillIncomplete: "失敗塊仍未全部補上",
  unclaimed: "沒有收到生成請求，已停止",
  canceled: "已取消",
  done: "已完成",
  failed: "生成失敗",
};
