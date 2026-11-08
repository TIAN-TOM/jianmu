// 备份导入的错误码：认不出的文件、更新的版本写的备份、整份结构坏了。逐条的坏记录不报错，跳过并计数。

export type BackupErrorCode = "BACKUP_UNRECOGNIZED" | "BACKUP_TOO_NEW" | "BACKUP_DAMAGED";

export const BACKUP_ERROR_TEXT: Readonly<Record<BackupErrorCode, string>> = {
  BACKUP_UNRECOGNIZED: "这不是简幕的备份文件。",
  BACKUP_TOO_NEW: "这份备份来自更新的版本，请先升级扩展。",
  BACKUP_DAMAGED: "备份文件里有一部分格式不对，整份都没有导入。",
};
