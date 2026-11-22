// 侧边栏里解释当前画面的文案，繁体这份：只从 frame-text.ts 引用，跟它一起只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包。
// 模块顶层只放字面量和函数。
import type { FrameText } from "./frame-text.ts";

export const FRAME_HANT: FrameText = {
  title: "畫面",
  label: "畫面解釋",
  button: "解釋畫面",
  noVideo: "先打開一部影片",
  jumpBack: (time) => `跳回這個影格 ${time}`,
  dismiss: "關掉這則解釋",
  openSettings: "打開設定",
  phases: {
    checking: "正在確認模型能不能看圖…",
    capturing: "正在擷取畫面…",
    thinking: "正在請模型看圖…",
    finished: "",
  },
};
