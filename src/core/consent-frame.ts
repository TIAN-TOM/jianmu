// 解释当前画面要加进两份说明的条目：跟着画面功能走，只从 consent.ts 的开关分支引用，构建开关 FEATURE_FRAME_EXPLAIN 关着的构建里没有。
// 首发前不为扩大范围升版，这几条并进当前那一版；条目变了指纹跟着变，确认过的人会再被问一次。
import type { ActivationKind, DataConsentKind, NoticeItem } from "./consent.ts";

/** 首次启用说明：多读当前的一帧画面。 */
export const FRAME_ACTIVATION_ITEMS: readonly NoticeItem<ActivationKind>[] = [
  { kind: "read", id: "current-frame", text: "点「解释当前画面」时，视频当前的一帧画面，只用于这一次，不保存" },
];

/** 数据说明：多发当前的一帧画面，前后几句字幕已经在「字幕文本」里。 */
export const FRAME_DATA_ITEMS: readonly NoticeItem<DataConsentKind>[] = [
  {
    kind: "category",
    id: "current-frame",
    text: "点「解释当前画面」时视频当前的一帧画面，只用于这一次，不保存",
  },
  {
    kind: "purpose",
    id: "frame-explain",
    text: "解释当前画面",
    shownWith: { id: "ai-features", combined: "翻译、整理字幕（补标点、改同音错字）、概览、一句话结论、划词解释、笔记润色、问答、粗筛写结论和解释当前画面" },
  },
];
