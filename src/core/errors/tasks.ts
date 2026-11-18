// 任务的错误码：任务没了、同一个视频已经有任务在跑、卡片上生成得太频繁。
import type { ErrorCopy } from "./copy.ts";

export type TaskErrorCode = "TASK_NOT_FOUND" | "TASK_ALREADY_RUNNING" | "CARD_RATE_LIMITED";

export const TASK_ERROR_TEXT: Readonly<Record<TaskErrorCode, ErrorCopy>> = {
  TASK_NOT_FOUND: { cause: "这个任务已经结束了。" },
  TASK_ALREADY_RUNNING: { cause: "这个视频已经有任务在跑。", impact: "这次没有开始，不花额度。", next: "等它跑完，或者先停掉它再开始。" },
  CARD_RATE_LIMITED: {
    cause: "卡片上生成得太频繁。",
    impact: "这次没有生成，不花额度。",
    next: "过一分钟再点，或者点「打开侧边栏」在那里生成。",
  },
};
