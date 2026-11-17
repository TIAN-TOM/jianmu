// 备份导入的错误码：认不出的文件、更新的版本写的备份、整份结构坏了。逐条的坏记录不报错，跳过并计数。
import type { ErrorCopy } from "./copy.ts";

export type BackupErrorCode = "BACKUP_UNRECOGNIZED" | "BACKUP_TOO_NEW" | "BACKUP_DAMAGED";

const UNTOUCHED = "什么都没导入，这台电脑上原有的资料没动。";

export const BACKUP_ERROR_TEXT: Readonly<Record<BackupErrorCode, ErrorCopy>> = {
  BACKUP_UNRECOGNIZED: { cause: "这不是简幕的备份文件。", impact: UNTOUCHED, next: "换成设置页「导出备份」存下的文件再试。" },
  BACKUP_TOO_NEW: { cause: "这份备份来自更新版本的简幕。", impact: UNTOUCHED, next: "先把简幕升级到最新版，再导入。" },
  BACKUP_DAMAGED: { cause: "备份文件里有一部分格式不对。", impact: "整份都没有导入，这台电脑上原有的资料没动。", next: "换一份完整的备份再试。" },
};
