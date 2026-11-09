// 概览：开始生成、补失败块、读本机已有的概览。生成和补块认领的是先经任务登记的任务，服务核对任务的种类和视频；
// 卡片只能开始生成，只认登记时拿到的一次性令牌，不能重新生成，登记时已经过了卡片开关和限频。
import { fail } from "../../core/errors.ts";
import type { OverviewGetRequest, OverviewRetryRequest, OverviewStartRequest } from "../../shared/messages/overview.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import type { OverviewService } from "../services/overview/index.ts";
import { isVideoKey } from "./validate.ts";

export interface OverviewRouteDeps {
  readonly overview: OverviewService;
  readonly cardLimits: Pick<CardLimits, "redeemToken">;
}

type OverviewRoutes = { readonly [K in "overview.start" | "overview.retryFailed" | "overview.get"]: Route<K> };

const MAX_ID = 100;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const onlyKeys = (value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

function isStartRequest(req: unknown): req is OverviewStartRequest {
  if (!isPlainObject(req) || !onlyKeys(req, ["video", "taskId", "token", "fresh"]) || !isVideoKey(req.video)) return false;
  if (req.fresh !== undefined && typeof req.fresh !== "boolean") return false;
  // 任务号和令牌恰好带一个。
  return Object.hasOwn(req, "taskId") ? isId(req.taskId) && !Object.hasOwn(req, "token") : isId(req.token);
}

function isRetryRequest(req: unknown): req is OverviewRetryRequest {
  return isPlainObject(req) && onlyKeys(req, ["video", "taskId"]) && isVideoKey(req.video) && isId(req.taskId);
}

function isGetRequest(req: unknown): req is OverviewGetRequest {
  return isPlainObject(req) && onlyKeys(req, ["video"]) && isVideoKey(req.video);
}

export function overviewRoutes({ overview, cardLimits }: OverviewRouteDeps): OverviewRoutes {
  return {
    "overview.start": {
      senders: ["panel", "card"],
      validate: isStartRequest,
      async handler(req, { sender }) {
        if (sender.kind === "card") {
          // 卡片不收任务号、不能重新生成：只认登记时换到的令牌，用一次就作废。
          if (req.taskId !== undefined || req.token === undefined || req.fresh) return fail("FORBIDDEN");
          const taskId = cardLimits.redeemToken(req.token);
          return taskId ? overview.generate(taskId, req.video, { fresh: false }) : fail("TASK_NOT_FOUND");
        }
        if (req.taskId === undefined) return fail("FORBIDDEN");
        return overview.generate(req.taskId, req.video, { fresh: req.fresh === true });
      },
    },
    "overview.retryFailed": {
      senders: ["panel", "page"],
      pages: ["options", "triage"],
      validate: isRetryRequest,
      handler: (req) => overview.retryFailed(req.taskId, req.video),
    },
    "overview.get": {
      senders: ["panel", "page"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isGetRequest,
      handler: (req) => overview.get(req.video),
    },
  };
}
