// 问答和划词解释：凭登记时拿到的任务号开始，服务核对任务的种类和视频；问答历史按视频读、按条删。
// 卡片只能提问，只认登记时拿到的一次性令牌，登记时已经过了卡片开关和限频；问答历史和划词解释不收卡片。
import { fail } from "../../core/errors.ts";
import type { ExplainRequest, QaAskRequest, QaDeleteRequest, QaHistoryRequest } from "../../shared/messages/qa.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import type { ExplainService } from "../services/explain.ts";
import type { QaService } from "../services/qa.ts";
import { hasOnly, isId, isPlainObject, isVideoKey } from "./validate.ts";

export interface QaRouteDeps {
  readonly qa: QaService;
  readonly explain: ExplainService;
  readonly cardLimits: Pick<CardLimits, "redeemToken">;
}

type QaRoutes = { readonly [K in "qa.ask" | "qa.history" | "qa.delete" | "explain.selection"]: Route<K> };

const PAGES = ["options", "triage"] as const;

const isTaskRequest = (req: unknown): req is ExplainRequest =>
  isPlainObject(req) && hasOnly(req, ["video", "taskId"]) && isVideoKey(req.video) && isId(req.taskId);

/** 提问：视频加上任务号或令牌，两样恰好带一个。 */
const isAskRequest = (req: unknown): req is QaAskRequest =>
  isTaskRequest(req) || (isPlainObject(req) && hasOnly(req, ["video", "token"]) && isVideoKey(req.video) && isId(req.token));

const isHistoryRequest = (req: unknown): req is QaHistoryRequest => isPlainObject(req) && hasOnly(req, ["video"]) && isVideoKey(req.video);

const isDeleteRequest = (req: unknown): req is QaDeleteRequest => isPlainObject(req) && hasOnly(req, ["id"]) && isId(req.id);

export function qaRoutes({ qa, explain, cardLimits }: QaRouteDeps): QaRoutes {
  return {
    "qa.ask": {
      senders: ["panel", "page", "card"],
      pages: PAGES,
      validate: isAskRequest,
      async handler(req, { sender }) {
        if (sender.kind === "card") {
          if (req.taskId !== undefined || req.token === undefined) return fail("FORBIDDEN");
          const taskId = cardLimits.redeemToken(req.token);
          return taskId ? qa.ask(taskId, req.video) : fail("TASK_NOT_FOUND");
        }
        return req.taskId === undefined ? fail("FORBIDDEN") : qa.ask(req.taskId, req.video);
      },
    },
    "qa.history": {
      senders: ["panel", "page"],
      pages: PAGES,
      idempotent: true,
      validate: isHistoryRequest,
      handler: (req) => qa.history(req.video),
    },
    "qa.delete": {
      senders: ["panel", "page"],
      pages: PAGES,
      validate: isDeleteRequest,
      handler: (req) => qa.remove(req.id),
    },
    "explain.selection": {
      senders: ["panel", "page"],
      pages: PAGES,
      validate: isTaskRequest,
      handler: (req) => explain.explain(req.taskId, req.video),
    },
  };
}
