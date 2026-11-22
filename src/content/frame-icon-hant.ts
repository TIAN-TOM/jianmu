// 播放页上「解释当前画面」图标的繁体文案：只从 frame-icon.ts 引用，跟它一起只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包。
// 模块顶层只放字面量。
import type { FrameIconText } from "./frame-icon.ts";

export const FRAME_ICON_HANT: FrameIconText = {
  title: "解釋目前畫面",
  panelHint: "結果在側邊欄：點選瀏覽器工具列上的簡幕圖示，打開側邊欄查看。",
  sending: "傳送中…",
  tooMany: "點太多次了",
  notSent: "沒有送出",
  inPanel: "結果在側邊欄",
  clickIcon: "點選簡幕圖示看結果",
  refusals: {
    NO_VIDEO: { short: "找不到影片", long: "頁面上找不到影片，不擷取。" },
    AD_PLAYING: { short: "正在播廣告", long: "正在播廣告，等廣告播完再擷取。" },
    VIDEO_CHANGED: { short: "影片還在切換", long: "頁面上的影片換了或者還在切換，不擷取。" },
    FRAME_NOT_READY: { short: "畫面還沒好", long: "畫面還沒載入好，等影片出現畫面再擷取。" },
    PROTECTED: { short: "畫面受保護", long: "這部影片是加密播放，或者認不出是不是加密播放，不擷取。" },
    CANVAS_TAINTED: { short: "讀不到畫面", long: "瀏覽器不讓讀取這部影片的畫面，不擷取。" },
    NOT_FOREGROUND: { short: "不在前景", long: "影片頁不在前景，切回來再擷取。" },
  },
};
