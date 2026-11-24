// 设置页里解释当前画面的文案，繁体这份：只从 frame-text.ts 引用，跟它一起只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包。
// 模块顶层只放字面量和函数。
import type { FrameText } from "./frame-text.ts";

export const FRAME_HANT: FrameText = {
  slot: "畫面解釋",
  probeHint: "畫面解釋要選能看圖的模型。",
  probing: "正在檢測",
  probe: "檢測能不能看圖",
  probeFailed: (reason) => `畫面解釋：沒有檢測成功，${reason}`,
  canSee: (model) => `畫面解釋（${model}）能看圖。`,
  cannotSee: (model) => `畫面解釋（${model}）不能看圖：在「按功能選模型」裡替畫面解釋換一個能看圖的模型。`,
};
