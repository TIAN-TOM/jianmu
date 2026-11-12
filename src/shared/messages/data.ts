// 设置页「资料」一节的三条消息：导出备份、导入备份、清除本机数据。
import type { ClearScope } from "../../core/clear-guard.ts";
import type { Backup } from "../../core/backup/format.ts";
import type { RecordKind } from "../../core/backup/records.ts";
import type { EmptyRequest } from "./core.ts";

/** 导入的是读出来的文件内容，形状由后台核对。 */
export interface BackupImportRequest {
  readonly payload: unknown;
}

export interface ImportCount {
  readonly added: number;
  readonly updated: number;
  /** 格式不对、没有导入的条数。 */
  readonly skipped: number;
}

export interface BackupImportReply {
  readonly counts: Readonly<Record<RecordKind, ImportCount>>;
  /** 旧版本的备份带着自定义提示词，没有导入。 */
  readonly promptsDropped: boolean;
}

export interface DataClearRequest {
  readonly scope: ClearScope;
}

export interface DataApi {
  "backup.export": { req: EmptyRequest; res: Backup };
  "backup.import": { req: BackupImportRequest; res: BackupImportReply };
  "data.clear": { req: DataClearRequest; res: EmptyRequest };
}
