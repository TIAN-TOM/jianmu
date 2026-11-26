// 用官方总结写一句话结论：收侧边栏和卡片，认领先经任务登记的结论任务，服务核对任务的种类和视频。
// 侧边栏带任务号；卡片只认登记时拿到的一次性令牌，用一次就作废，登记时已经过了卡片开关和限频。
import { fail } from "../../core/errors.ts";
import type { VerdictFromOfficialRequest } from "../../shared/messages/overview.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import type { VerdictService } from "../services/overview/verdict.ts";
import { isVideoKey } from "./validate.ts";

export interface VerdictRouteDeps {
  readonly verdict: VerdictService;
  readonly cardLimits: Pick<CardLimits, "redeemToken">;
}

type VerdictRoutes = { readonly [K in "verdict.fromOfficial"]: Route<K> };

const MAX_ID = 100;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

/** 视频加上任务号或令牌，两样恰好带一个。 */
function isFromOfficialRequest(req: unknown): req is VerdictFromOfficialRequest {
  if (!isPlainObject(req) || Object.keys(req).some((key) => key !== "video" && key !== "taskId" && key !== "token") || !isVideoKey(req.video)) return false;
  return Object.hasOwn(req, "taskId") ? isId(req.taskId) && !Object.hasOwn(req, "token") : isId(req.token);
}

export function verdictRoutes({ verdict, cardLimits }: VerdictRouteDeps): VerdictRoutes {
  return {
    "verdict.fromOfficial": {
      senders: ["panel", "card"],
      validate: isFromOfficialRequest,
      async handler(req, { sender }) {
        if (sender.kind === "card") {
          if (req.taskId !== undefined || req.token === undefined) return fail("FORBIDDEN");
          const taskId = cardLimits.redeemToken(req.token);
          return taskId ? verdict.fromOfficial(taskId, req.video) : fail("TASK_NOT_FOUND");
        }
        return req.taskId === undefined ? fail("FORBIDDEN") : verdict.fromOfficial(req.taskId, req.video);
      },
    },
  };
}
