// 设置页「资料」一节：导出、导入备份走两条长连接，分段传（单条消息有大小上限）；清除本机数据是一条消息。
import type { ClearScope } from "../../core/clear-guard.ts";
import type { BackupPart } from "../../core/backup/parts.ts";
import type { RecordKind } from "../../core/backup/records.ts";
import type { EmptyRequest } from "./core.ts";

/** 导出：页面发一条开始，后台先报每类多少条，再一段段发记录，最后报完。 */
export type BackupExportIn = { readonly type: "start" };

export type BackupExportOut =
  | { readonly type: "head"; readonly exportedAt: string; readonly counts: Readonly<Record<RecordKind, number>> }
  | { readonly type: "part"; readonly part: BackupPart }
  | { readonly type: "end" };

/** 导入：页面读完文件、认过格式，一段段发；记录的形状后台再核对一遍。后台回完一段页面才发下一段。 */
export type BackupImportIn = { readonly type: "part"; readonly seq: number; readonly kind: RecordKind; readonly records: readonly unknown[] };

export type BackupImportOut = {
  readonly type: "merged";
  readonly seq: number;
  /** 这一段新增和更新的主键，页面按主键去重计数。 */
  readonly added: readonly string[];
  readonly updated: readonly string[];
  /** 后台核对时又跳过的条数。 */
  readonly skipped: number;
};

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
  "data.clear": { req: DataClearRequest; res: EmptyRequest };
}
