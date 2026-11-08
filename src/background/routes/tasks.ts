// 任务：列出、登记、取消。卡片只能登记概览，新起的要过每分钟 3 次的限频，凭一次性令牌开始生成；
// 接上已经在跑的同一个任务不算一次。卡片开关在分发时已经查过。
import { fail, ok } from "../../core/errors.ts";
import type { TaskCancelRequest, TaskStartRequest, StartableTaskKind } from "../../shared/messages/tasks.ts";
import type { FeatureSlotId } from "../../shared/settings-schema.ts";
import type { AiWiring } from "../ai.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import type { TaskRunner } from "../tasks.ts";
import { isEmptyRequest, isVideoKey } from "./validate.ts";

export interface TaskRouteDeps {
  readonly tasks: Pick<TaskRunner, "register" | "cancel" | "list">;
  readonly cardLimits: CardLimits;
  readonly ai: Pick<AiWiring, "freeze">;
}

type TaskRoutes = { readonly [K in "task.list" | "task.start" | "task.cancel"]: Route<K> };

/** 每种能登记的任务用哪项功能的模型。 */
const FEATURE_OF: Readonly<Record<StartableTaskKind, FeatureSlotId>> = { overview: "analysis" };

/** 卡片只能登记的种类。 */
const CARD_KINDS: ReadonlySet<string> = new Set<StartableTaskKind>(["overview"]);

const MAX_TASK_ID = 100;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isStartRequest(req: unknown): req is TaskStartRequest {
  return isPlainObject(req) && hasOnly(req, ["kind", "video"]) && Object.hasOwn(FEATURE_OF, String(req.kind)) && isVideoKey(req.video);
}

function isCancelRequest(req: unknown): req is TaskCancelRequest {
  return isPlainObject(req) && hasOnly(req, ["taskId"]) && typeof req.taskId === "string" && req.taskId.length > 0 && req.taskId.length <= MAX_TASK_ID;
}

export function taskRoutes({ tasks, cardLimits, ai }: TaskRouteDeps): TaskRoutes {
  return {
    "task.list": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isEmptyRequest,
      handler: async () => ok({ tasks: tasks.list() }),
    },
    "task.start": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      validate: isStartRequest,
      async handler(req, { sender }) {
        const card = sender.kind === "card";
        if (card && !CARD_KINDS.has(req.kind)) return fail("FORBIDDEN");
        const gen = await ai.freeze(FEATURE_OF[req.kind]);
        const spec = { kind: req.kind, origin: card ? "card" : "user", video: req.video, gen, followsPage: false } as const;
        // 发消息登记的页面不跟着任务走：关掉页面，任务照常跑完。
        const registered = await tasks.register(spec, {}, card ? { admit: cardLimits.admitGenerate } : {});
        if ("refused" in registered) return fail("CARD_RATE_LIMITED");
        if ("conflict" in registered) return fail("TASK_ALREADY_RUNNING");
        const { task, joined } = registered;
        return ok(card && !joined ? { task, joined, token: cardLimits.issueToken(task.id) } : { task, joined });
      },
    },
    "task.cancel": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      validate: isCancelRequest,
      async handler(req) {
        const task = tasks.cancel(req.taskId);
        return task ? ok({ task }) : fail("TASK_NOT_FOUND");
      },
    },
  };
}
