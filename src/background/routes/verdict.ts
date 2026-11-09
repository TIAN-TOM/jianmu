// 用官方总结写一句话结论：只收侧边栏，认领先经任务登记的结论任务，服务核对任务的种类和视频。
import type { VerdictFromOfficialRequest } from "../../shared/messages/overview.ts";
import type { Route } from "../router.ts";
import type { VerdictService } from "../services/overview/verdict.ts";
import { isVideoKey } from "./validate.ts";

export interface VerdictRouteDeps {
  readonly verdict: VerdictService;
}

type VerdictRoutes = { readonly [K in "verdict.fromOfficial"]: Route<K> };

const MAX_ID = 100;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function isFromOfficialRequest(req: unknown): req is VerdictFromOfficialRequest {
  if (!isPlainObject(req) || Object.keys(req).some((key) => key !== "video" && key !== "taskId")) return false;
  return isVideoKey(req.video) && typeof req.taskId === "string" && req.taskId.length > 0 && req.taskId.length <= MAX_ID;
}

export function verdictRoutes({ verdict }: VerdictRouteDeps): VerdictRoutes {
  return {
    "verdict.fromOfficial": {
      senders: ["panel"],
      validate: isFromOfficialRequest,
      handler: (req) => verdict.fromOfficial(req.taskId, req.video),
    },
  };
}
