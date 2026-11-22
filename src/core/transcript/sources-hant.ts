// 简幕替官方总结字幕和导入文件起的名字，繁体这份。存下来的名字照旧是简体那份，只在显示时换。模块顶层只放字面量。
import type { CaptionKind } from "./sources.ts";

export const SOURCE_LABELS_HANT: Readonly<Partial<Record<CaptionKind, string>>> = {
  "official-ai": "B 站官方總結裡的 AI 字幕",
  imported: "匯入的字幕檔案",
};
