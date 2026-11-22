// 粗筛的展示文字和 Markdown 清单导出的固定文字，繁体这份。形状由 export.ts 里简体那份定，少一条、多一条或签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { ExportText } from "./export.ts";

export const EXPORT_HANT: ExportText = {
  status: {
    ok: "有官方總結",
    none: "沒有官方總結",
    queued: "B 站目前沒有這部影片的官方總結",
    unsupported: "B 站不替這部影片做總結",
    "need-login": "要先在瀏覽器裡登入 B 站",
    failed: "請求失敗，再點選開始會重試",
  },
  unavailable: "影片已失效或暫時無法觀看，沒有去取得官方總結",
  notFetched: "還沒取得官方總結",
  withReason: (text, reason) => `${text}（${reason}）`,
  finished: "已看完",
  notStarted: "還沒看",
  percent: (percent) => `（${percent}%）`,
  watchedTo: (at, percent) => `看到 ${at}${percent}`,
  fromOfficial: "根據 B 站官方總結",
  fromOverview: "根據概覽",
  heading: "# 稍後再看粗篩",
  exported: (at, count) => `匯出於 ${at}，共 ${count} 部影片。`,
  group: (name, count) => `## ${name}（${count}）`,
  verdict: (summary, source) => `  - 結論：${summary}（${source}）`,
  value: (text) => `  - 核心價值：${text}`,
  reason: (text) => `  - 理由：${text}`,
  official: (text) => `  - 官方總結：${text}`,
  fileName: (stamp) => `簡幕-稍後再看-${stamp}.md`,
};
