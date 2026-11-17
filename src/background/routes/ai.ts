// 模型服务：配置检查给要发请求的页面看能不能用，打开就出结论停着时也一起说；拉模型列表、测试连接和推理强度预览只有设置页用得上。
// 这里只拿接线给的入口，不直接碰传输层，所以路由层发不出不核对同意的请求。
import { ok } from "../../core/errors.ts";
import type { EffortPreviewRequest, TestConnectionRequest } from "../../shared/messages/ai.ts";
import { EFFORTS, FEATURE_MODEL_SLOTS } from "../../shared/settings-schema.ts";
import type { AiWiring } from "../ai.ts";
import type { AutoGenerate } from "../services/auto-generate.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

export interface AiRouteDeps {
  readonly ai: Pick<AiWiring, "configCheck" | "listModels" | "testConnection" | "effortPreview">;
  readonly auto?: Pick<AutoGenerate, "paused">;
}

type AiRoutes = { readonly [K in "config.check" | "models.list" | "ai.testConnection" | "ai.effortPreview"]: Route<K> };

const FEATURES: readonly unknown[] = FEATURE_MODEL_SLOTS.map(({ id }) => id);

/** 空对象，或者只带一个认得的功能。 */
function isTestRequest(req: unknown): req is TestConnectionRequest {
  if (isEmptyRequest(req)) return true;
  if (typeof req !== "object" || req === null || Array.isArray(req)) return false;
  const keys = Object.keys(req);
  return keys.length === 1 && keys[0] === "feature" && FEATURES.includes((req as { feature?: unknown }).feature);
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 空对象，或者只带一张档位表：表里只有认得的功能和档位。 */
function isEffortPreviewRequest(req: unknown): req is EffortPreviewRequest {
  if (isEmptyRequest(req)) return true;
  if (!isRecord(req)) return false;
  const keys = Object.keys(req);
  if (keys.length !== 1 || keys[0] !== "efforts" || !isRecord(req["efforts"])) return false;
  return Object.entries(req["efforts"]).every(
    ([feature, effort]) => FEATURES.includes(feature) && (EFFORTS as readonly unknown[]).includes(effort),
  );
}

export function aiRoutes({ ai, auto }: AiRouteDeps): AiRoutes {
  return {
    "config.check": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isEmptyRequest,
      async handler() {
        const [view, paused] = await Promise.all([ai.configCheck(), auto ? auto.paused() : null]);
        return ok(paused ? { ...view, autoPaused: paused } : view);
      },
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
    // 只算不发：本机的映射表和已缓存的能力，零网络请求。
    "ai.effortPreview": {
      senders: ["page"],
      pages: ["options"],
      idempotent: true,
      validate: isEffortPreviewRequest,
      handler: async (req) => ok(await ai.effortPreview(req.efforts)),
    },
  };
}
