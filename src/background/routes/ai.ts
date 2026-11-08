// 模型服务：配置检查给要发请求的页面看能不能用；拉模型列表和测试连接只有设置页有这两个按钮。
// 这里只拿接线给的入口，不直接碰传输层，所以路由层发不出不核对同意的请求。
import { ok } from "../../core/errors.ts";
import type { TestConnectionRequest } from "../../shared/messages/ai.ts";
import { FEATURE_MODEL_SLOTS } from "../../shared/settings-schema.ts";
import type { AiWiring } from "../ai.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

export interface AiRouteDeps {
  readonly ai: Pick<AiWiring, "configCheck" | "listModels" | "testConnection">;
}

type AiRoutes = { readonly [K in "config.check" | "models.list" | "ai.testConnection"]: Route<K> };

const FEATURES: readonly unknown[] = FEATURE_MODEL_SLOTS.map(({ id }) => id);

/** 空对象，或者只带一个认得的功能。 */
function isTestRequest(req: unknown): req is TestConnectionRequest {
  if (isEmptyRequest(req)) return true;
  if (typeof req !== "object" || req === null || Array.isArray(req)) return false;
  const keys = Object.keys(req);
  return keys.length === 1 && keys[0] === "feature" && FEATURES.includes((req as { feature?: unknown }).feature);
}

export function aiRoutes({ ai }: AiRouteDeps): AiRoutes {
  return {
    "config.check": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isEmptyRequest,
      handler: async () => ok(await ai.configCheck()),
    },
    "models.list": {
      senders: ["page"],
      pages: ["options"],
      validate: isEmptyRequest,
      handler: () => ai.listModels(),
    },
    "ai.testConnection": {
      senders: ["page"],
      pages: ["options"],
      validate: isTestRequest,
      handler: (req) => ai.testConnection(req.feature),
    },
  };
}
