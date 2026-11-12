// 批次端口收侧边栏和粗筛页：粗筛两边都能发，本窗口全部生成只收侧边栏。会发起读取或模型请求的消息每条重查启用；
// 页面断开只退订它自己。读粗筛状态收侧边栏、设置页和粗筛页。
import { ok } from "../../core/errors.ts";
import type { BatchIn, TriageStep } from "../../shared/messages/batch.ts";
import type { SenderCtx } from "../senders.ts";
import type { PortSpec, Route } from "../router.ts";
import type { BatchService } from "../services/batch/index.ts";
import { isEmptyRequest, isVideoKey } from "./validate.ts";

/** 本窗口全部生成里只带窗口号的几条。 */
const WINDOW_PLAIN: ReadonlySet<unknown> = new Set(["window.count", "window.start", "window.stop", "window.watch", "window.dismiss"]);

/** 每条都重查启用的：会发起读取或模型请求的几条，加上要看标签页地址的清点。 */
const STARTS: ReadonlySet<string> = new Set(["triage.start", "window.count", "window.start", "window.retry"]);

const isWindowId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export interface BatchRouteDeps {
  readonly batch: Pick<BatchService, "handle" | "leave" | "state">;
}

const STEPS: ReadonlySet<unknown> = new Set<TriageStep>(["list", "official", "verdict"]);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isBatchIn(message: unknown, ctx: SenderCtx): message is BatchIn {
  if (!isPlainObject(message)) return false;
  if (message.type === "triage.stop") return hasOnly(message, ["type"]);
  if (message.type === "triage.start") return hasOnly(message, ["type", "step"]) && STEPS.has(message.step);
  // 本窗口全部生成是侧边栏的功能，粗筛页发不起。
  if (ctx.kind !== "panel") return false;
  if (WINDOW_PLAIN.has(message.type)) return hasOnly(message, ["type", "windowId"]) && isWindowId(message.windowId);
  return message.type === "window.retry" && hasOnly(message, ["type", "windowId", "video"]) && isWindowId(message.windowId) && isVideoKey(message.video);
}

export function batchPort({ batch }: BatchRouteDeps): { readonly batch: PortSpec<"batch"> } {
  return {
    batch: {
      senders: ["panel", "page"],
      pages: ["triage"],
      validate: isBatchIn,
      starts: (message) => STARTS.has(message.type),
      onConnect(port) {
        const listener = { id: port.id, post: port.post };
        return {
          onMessage: (message) => batch.handle(message, listener),
          onDisconnect: () => batch.leave(port.id),
        };
      },
    },
  };
}

export function batchRoutes({ batch }: BatchRouteDeps): { readonly "triage.state": Route<"triage.state"> } {
  return {
    "triage.state": {
      senders: ["panel", "page"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isEmptyRequest,
      handler: async () => ok(await batch.state()),
    },
  };
}
