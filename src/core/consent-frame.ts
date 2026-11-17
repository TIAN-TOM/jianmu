// 解释当前画面要加进说明的条目：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 consent.ts 的开关分支引用。
import type { ActivationKind, NoticeVersion } from "./consent.ts";

/** 首次启用说明第 4 版：多读当前的一帧画面。开关关着的构建停在第 3 版。 */
export const FRAME_ACTIVATION_VERSION: NoticeVersion<ActivationKind> = {
  version: 4,
  requires: "frameExplain",
  items: [{ kind: "read", id: "current-frame", text: "点「解释当前画面」时，视频当前的一帧画面，只用于这一次，不保存" }],
};
