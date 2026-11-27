// 资料：导出、导入备份走两条长连接，清除本机数据是一条消息，都只收设置页。导出和清除确认启用之前也放行：
// 只碰本机存储，不发平台和模型请求，不查标签页；导入要先确认启用。
// 备份分段传：单条消息有大小上限，整份大了一次传不过去。
import { splitBackup } from "../../core/backup/parts.ts";
import { RECORD_KINDS, type RecordKind } from "../../core/backup/records.ts";
import { ok, type ErrorCode } from "../../core/errors.ts";
import { isQuotaError } from "../../platform/storage.ts";
import type { PortNotice } from "../../shared/messages.ts";
import type { BackupExportIn, BackupImportIn, DataClearRequest } from "../../shared/messages/data.ts";
import { errorLabel, type Log } from "../log.ts";
import type { PortHandle, PortSpec, Route } from "../router.ts";
import type { DataService } from "../services/data.ts";
import { hasOnly, isRecord } from "./validate.ts";

export interface DataRouteDeps {
  readonly data: DataService;
  readonly log: Pick<Log, "error">;
}

type DataPorts = { readonly [P in "backup.export" | "backup.import"]: PortSpec<P> };

function isClearRequest(req: unknown): req is DataClearRequest {
  return isRecord(req) && Object.keys(req).length === 1 && (req.scope === "cache" || req.scope === "notes" || req.scope === "all");
}

const isExportIn = (message: unknown): message is BackupExportIn => isRecord(message) && hasOnly(message, ["type"]) && message.type === "start";

function isImportIn(message: unknown): message is BackupImportIn {
  return (
    isRecord(message) &&
    hasOnly(message, ["type", "seq", "kind", "records"]) &&
    message.type === "part" &&
    Number.isSafeInteger(message.seq) &&
    RECORD_KINDS.includes(message.kind as RecordKind) &&
    Array.isArray(message.records)
  );
}

/** 出了错先告诉页面原因再断开，页面分得清是失败还是中途断了。 */
function abort(port: PortHandle<unknown>, log: DataRouteDeps["log"], what: string, error: unknown): void {
  const code: ErrorCode = isQuotaError(error) ? "STORAGE_FULL" : "BACKGROUND_FAILED";
  if (code === "BACKGROUND_FAILED") log.error(`${what}失败`, errorLabel(error));
  port.post({ type: "port.error", code } satisfies PortNotice);
  port.close();
}

export function dataPorts({ data, log }: DataRouteDeps): DataPorts {
  return {
    "backup.export": {
      senders: ["page"],
      pages: ["options"],
      beforeEnable: true,
      validate: isExportIn,
      starts: () => false,
      onConnect(port) {
        const session = data.openExport();
        let started = false;
        return {
          async onMessage() {
            if (started) return;
            started = true;
            try {
              const backup = await session.read();
              const { exportedAt, notes, overviews, qa, translations } = backup;
              port.post({ type: "head", exportedAt, counts: { notes: notes.length, overviews: overviews.length, qa: qa.length, translations: translations.length } });
              for (const part of splitBackup(backup)) port.post({ type: "part", part });
              port.post({ type: "end" });
            } catch (error) {
              abort(port, log, "导出备份", error);
            }
          },
          // 页面收完、出错断开、确认失效被关，都走到这里。
          onDisconnect: () => session.close(),
        };
      },
    },
    "backup.import": {
      senders: ["page"],
      pages: ["options"],
      validate: isImportIn,
      starts: () => false,
      onConnect(port) {
        const session = data.openImport(port.since);
        // 一段合并完再轮到下一段；页面也是等回了才发下一段。
        let queue: Promise<void> = Promise.resolve();
        return {
          onMessage(message) {
            queue = queue.then(async () => {
              try {
                const merged = await session.merge(message.kind, message.records);
                if (!merged.ok) {
                  port.post({ type: "port.error", code: merged.code });
                  port.close();
                  return;
                }
                port.post({ type: "merged", seq: message.seq, ...merged.value });
              } catch (error) {
                abort(port, log, "导入备份", error);
              }
            });
            return queue;
          },
          // 在合并的那一段做完才关上：整次导入（不只单条消息）都算忙。
          onDisconnect: () => void queue.then(() => session.close()),
        };
      },
    },
  };
}

export function dataRoutes({ data }: Pick<DataRouteDeps, "data">): { readonly "data.clear": Route<"data.clear"> } {
  return {
    "data.clear": {
      senders: ["page"],
      pages: ["options"],
      beforeEnable: true,
      validate: isClearRequest,
      async handler(req) {
        await data.clear(req.scope);
        return ok({});
      },
    },
  };
}
