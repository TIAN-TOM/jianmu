// 资料：导出、导入备份，清除本机数据，都只收设置页。导出和清除确认启用之前也放行：只碰本机存储，
// 不发平台和模型请求，不查标签页；导入要先确认启用。
import { ok } from "../../core/errors.ts";
import type { BackupImportRequest, DataClearRequest } from "../../shared/messages/data.ts";
import type { Route } from "../router.ts";
import type { DataService } from "../services/data.ts";
import { isEmptyRequest } from "./validate.ts";

export interface DataRouteDeps {
  readonly data: DataService;
}

type DataRoutes = { readonly [K in "backup.export" | "backup.import" | "data.clear"]: Route<K> };

const isRecord = (req: unknown): req is Readonly<Record<string, unknown>> =>
  typeof req === "object" && req !== null && !Array.isArray(req);

function isImportRequest(req: unknown): req is BackupImportRequest {
  return isRecord(req) && Object.keys(req).length === 1 && Object.hasOwn(req, "payload");
}

function isClearRequest(req: unknown): req is DataClearRequest {
  return isRecord(req) && Object.keys(req).length === 1 && (req.scope === "cache" || req.scope === "all");
}

export function dataRoutes({ data }: DataRouteDeps): DataRoutes {
  return {
    "backup.export": {
      senders: ["page"],
      pages: ["options"],
      beforeEnable: true,
      validate: isEmptyRequest,
      handler: async () => ok(await data.exportBackup()),
    },
    "backup.import": {
      senders: ["page"],
      pages: ["options"],
      validate: isImportRequest,
      handler: (req) => data.importBackup(req.payload),
    },
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
