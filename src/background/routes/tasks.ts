// 任务：列出、登记、取消。能登记概览、用官方总结写结论、问答和划词解释；问答和解释的输入随登记一起交，进等价键：
// 同一个问题连点两下接上同一个任务。卡片只能登记概览、写结论和问答，新起的要过每分钟 3 次的限频，凭一次性令牌开始；
// 接上已经在跑的同一个任务不算一次。卡片开关在分发时已经查过。
import { fail, ok, type Result } from "../../core/errors.ts";
import type { TaskCancelRequest, TaskStartRequest, StartableTaskKind } from "../../shared/messages/tasks.ts";
import type { FeatureSlotId } from "../../shared/settings-schema.ts";
import type { AiWiring } from "../ai.ts";
import type { CardLimits } from "../limits.ts";
import type { Route } from "../router.ts";
import { selectionInput } from "../services/explain.ts";
import { questionInput } from "../services/qa.ts";
import type { TaskRunner } from "../tasks.ts";
import { hasOnly, isEmptyRequest, isId, isPlainObject, isText, isVideoKey } from "./validate.ts";

export interface TaskRouteDeps {
  readonly tasks: Pick<TaskRunner, "register" | "cancel" | "list">;
  readonly cardLimits: CardLimits;
  readonly ai: Pick<AiWiring, "freeze">;
}

type TaskRoutes = { readonly [K in "task.list" | "task.start" | "task.cancel"]: Route<K> };

interface StartableKindRule {
  /** 这种任务用哪项功能的模型。 */
  readonly feature: FeatureSlotId;
  /** 任务里另几步用的功能，登记时一起取定配置：概览合并好以后写结论用结论那项的模型。 */
  readonly stages?: readonly FeatureSlotId[];
  /** 卡片能不能登记。各条路由自己的发送方名单另外再查。 */
  readonly cardMayStart: boolean;
}

/** 能经消息登记的种类各自的规矩；不在这张表里的种类不收。 */
const STARTABLE_KINDS: Readonly<Record<StartableTaskKind, StartableKindRule>> = {
  overview: { feature: "analysis", stages: ["verdict"], cardMayStart: true },
  verdict: { feature: "verdict", cardMayStart: true },
  qa: { feature: "qa", cardMayStart: true },
  explain: { feature: "explain", cardMayStart: false },
};

/** 概览和写结论只收种类和视频；问答要带问题，解释要带选中的文字，附近的字幕可带可不带。 */
function isStartRequest(req: unknown): req is TaskStartRequest {
  if (!isPlainObject(req) || !Object.hasOwn(STARTABLE_KINDS, String(req.kind)) || !isVideoKey(req.video)) return false;
  if (req.kind === "qa") return hasOnly(req, ["kind", "video", "question"]) && isText(req.question);
  if (req.kind === "explain") {
    const keys = Object.hasOwn(req, "context") ? ["kind", "video", "selection", "context"] : ["kind", "video", "selection"];
    return hasOnly(req, keys) && isText(req.selection) && (req.context === undefined || isText(req.context));
  }
  return hasOnly(req, ["kind", "video"]);
}

/** 功能输入：问题、选中的文字。空的在登记前就拦下，不登记任务。 */
function inputOf(req: TaskStartRequest): Result<unknown> {
  if (req.kind === "qa") return questionInput(req.question);
  if (req.kind === "explain") return selectionInput(req.selection, req.context);
  return ok(undefined);
}

function isCancelRequest(req: unknown): req is TaskCancelRequest {
  return isPlainObject(req) && hasOnly(req, ["taskId"]) && isId(req.taskId);
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
        const rule = STARTABLE_KINDS[req.kind];
        if (card && !rule.cardMayStart) return fail("FORBIDDEN");
        const input = inputOf(req);
        if (!input.ok) return input;
        const gen = await ai.freeze(rule.feature);
        const stages = await Promise.all((rule.stages ?? []).map((feature) => ai.freeze(feature)));
        const spec = { kind: req.kind, origin: card ? "card" : "user", video: req.video, input: input.value, gen, stages, followsPage: false } as const;
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
