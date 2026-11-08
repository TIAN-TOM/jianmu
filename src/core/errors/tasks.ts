// 任务的错误码：任务没了、同一个视频已经有任务在跑、卡片上生成得太频繁。

export type TaskErrorCode = "TASK_NOT_FOUND" | "TASK_ALREADY_RUNNING" | "CARD_RATE_LIMITED";

export const TASK_ERROR_TEXT: Readonly<Record<TaskErrorCode, string>> = {
  TASK_NOT_FOUND: "任务已经结束。",
  TASK_ALREADY_RUNNING: "这个视频已经有任务在跑，可以先停掉它再开始。",
  CARD_RATE_LIMITED: "卡片上生成得太频繁，这次没有生成。可以打开完整面板生成，或者过一分钟再点。",
};
