// 问答和划词解释：凭登记时拿到的任务号开始，服务核对任务的种类和视频；问答历史按视频读、按条删。
import type { ExplainRequest, QaAskRequest, QaDeleteRequest, QaHistoryRequest } from "../../shared/messages/qa.ts";
import type { Route } from "../router.ts";
import type { ExplainService } from "../services/explain.ts";
import type { QaService } from "../services/qa.ts";
import { isVideoKey } from "./validate.ts";

export interface QaRouteDeps {
  readonly qa: QaService;
  readonly explain: ExplainService;
}

type QaRoutes = { readonly [K in "qa.ask" | "qa.history" | "qa.delete" | "explain.selection"]: Route<K> };

const MAX_ID = 100;
const PAGES = ["options", "triage"] as const;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

const isTaskRequest = (req: unknown): req is QaAskRequest & ExplainRequest =>
  isPlainObject(req) && hasOnly(req, ["video", "taskId"]) && isVideoKey(req.video) && isId(req.taskId);

const isHistoryRequest = (req: unknown): req is QaHistoryRequest => isPlainObject(req) && hasOnly(req, ["video"]) && isVideoKey(req.video);

const isDeleteRequest = (req: unknown): req is QaDeleteRequest => isPlainObject(req) && hasOnly(req, ["id"]) && isId(req.id);

export function qaRoutes({ qa, explain }: QaRouteDeps): QaRoutes {
  return {
    "qa.ask": {
      senders: ["panel", "page"],
      pages: PAGES,
      validate: isTaskRequest,
      handler: (req) => qa.ask(req.taskId, req.video),
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
