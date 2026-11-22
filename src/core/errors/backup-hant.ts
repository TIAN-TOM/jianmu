// 备份导入的错误码给用户看的三段话，繁体这份。码由简体那份（backup.ts）定，少一条、多一条，类型检查就报错。
import type { BackupErrorCode } from "./backup.ts";
import type { ErrorCopy } from "./copy.ts";

const UNTOUCHED = "什麼都沒匯入，這台電腦上原有的資料沒動。";

export const BACKUP_ERROR_TEXT_HANT: Readonly<Record<BackupErrorCode, ErrorCopy>> = {
  BACKUP_UNRECOGNIZED: { cause: "這不是簡幕的備份檔案。", impact: UNTOUCHED, next: "換成設定頁「匯出備份」存下的檔案再試。" },
  BACKUP_TOO_NEW: { cause: "這份備份來自更新版本的簡幕。", impact: UNTOUCHED, next: "先把簡幕更新到最新版，再匯入。" },
  BACKUP_DAMAGED: { cause: "備份檔案裡有一部分格式不對。", impact: "整份都沒有匯入，這台電腦上原有的資料沒動。", next: "換一份完整的備份再試。" },
};
