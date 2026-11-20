// 侧边栏里解释当前画面的文案：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 frame.ts 和 frame-view.tsx 引用。
// 模块顶层只放字面量和函数。
import type { FrameEntryView } from "../../shared/messages/frame.ts";
import type { UiLang } from "../shared/ui-lang.ts";

const FRAME_ZH = {
  title: "画面",
  label: "画面解释",
  button: "解释画面",
  noVideo: "先打开一个视频",
  jumpBack: (time: string) => `跳回这一帧 ${time}`,
  dismiss: "关掉这条解释",
  openSettings: "打开设置",
  phases: {
    checking: "正在查模型能不能看图…",
    capturing: "正在截取画面…",
    thinking: "正在请模型看图…",
    finished: "",
  } satisfies Readonly<Record<FrameEntryView["phase"], string>>,
};

export type FrameText = typeof FRAME_ZH;

const FRAME_EN: FrameText = {
  title: "Frame",
  label: "Frame explanations",
  button: "Explain this frame",
  noVideo: "Open a video first",
  jumpBack: (time) => `Jump back to this frame at ${time}`,
  dismiss: "Dismiss this explanation",
  openSettings: "Open settings",
  phases: {
    checking: "Checking whether the model can read images…",
    capturing: "Capturing the frame…",
    thinking: "Asking the model about the frame…",
    finished: "",
  },
};

export const frameText = (lang: UiLang = "zh"): FrameText => (lang === "en" ? FRAME_EN : FRAME_ZH);
