// 任务的错误码给用户看的三段话，繁体这份。码由简体那份（tasks.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { TaskErrorCode } from "./tasks.ts";

export const TASK_ERROR_TEXT_HANT: Readonly<Record<TaskErrorCode, ErrorCopy>> = {
  TASK_NOT_FOUND: { cause: "這個任務已經結束了。" },
  TASK_ALREADY_RUNNING: { cause: "這部影片已經有任務在執行。", impact: "這次沒有開始，不花額度。", next: "等它執行完，或者先停掉它再開始。" },
  CARD_RATE_LIMITED: {
    cause: "卡片上生成得太頻繁。",
    impact: "這次沒有生成，不花額度。",
    next: "過一分鐘再點，或者點選「打開側邊欄」在那裡生成。",
  },
};
