// 用官方总结写一句话结论：收侧边栏和卡片，认领先经任务登记的结论任务，服务核对任务的种类和视频。
// 侧边栏带任务号；卡片只认登记时拿到的一次性令牌，用一次就作废，登记时已经过了卡片开关和限频。
import type { VerdictFromOfficialRequest } from "../../shared/messages/overview.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import type { VerdictService } from "../services/overview/verdict.ts";
import { claimTaskId, hasTaskIdOrToken } from "./task-claim.ts";
import { isPlainObject, isVideoKey, keysWithin } from "./validate.ts";

export interface VerdictRouteDeps {
  readonly verdict: VerdictService;
  readonly cardLimits: Pick<CardLimits, "redeemToken">;
}

type VerdictRoutes = { readonly [K in "verdict.fromOfficial"]: Route<K> };

/** 视频加上任务号或令牌，两样恰好带一个。 */
function isFromOfficialRequest(req: unknown): req is VerdictFromOfficialRequest {
  return isPlainObject(req) && keysWithin(req, ["video"], ["taskId", "token"]) && isVideoKey(req.video) && hasTaskIdOrToken(req);
}

export function verdictRoutes({ verdict, cardLimits }: VerdictRouteDeps): VerdictRoutes {
  return {
    "verdict.fromOfficial": {
      senders: ["panel", "card"],
      validate: isFromOfficialRequest,
      async handler(req, { sender }) {
        const claim = claimTaskId(sender, req, cardLimits);
        return claim.ok ? verdict.fromOfficial(claim.taskId, req.video) : claim;
      },
    },
  };
}
