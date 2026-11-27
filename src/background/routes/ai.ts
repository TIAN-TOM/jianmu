// 模型服务：配置检查给要发请求的页面看能不能用，打开就出结论停着时也一起说；拉模型列表、测试连接和推理强度预览只有设置页用得上。
// 打开就出结论停着时，侧边栏和设置页上的「恢复」经 auto.resume 让它接着做，花不花额度由用户这一下决定。
// 这里只拿接线给的入口，不直接碰传输层，所以路由层发不出不核对同意的请求。
import { EFFORTS } from "../../core/ai/effort-level.ts";
import { ok } from "../../core/errors.ts";
import type { EffortPreviewRequest, TestConnectionRequest } from "../../shared/messages/ai.ts";
import { FEATURE_MODEL_SLOTS } from "../../shared/settings-schema.ts";
import type { AiWiring } from "../ai.ts";
import type { AutoGenerate } from "../services/auto-generate.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest, isRecord } from "./validate.ts";

export interface AiRouteDeps {
  readonly ai: Pick<AiWiring, "configCheck" | "listModels" | "testConnection" | "effortPreview">;
  readonly auto?: Pick<AutoGenerate, "paused" | "resume" | "consider">;
}

type AiRoutes = { readonly [K in "config.check" | "models.list" | "ai.testConnection" | "ai.effortPreview" | "auto.resume"]: Route<K> };

const FEATURES: readonly unknown[] = FEATURE_MODEL_SLOTS.map(({ id }) => id);

/** 空对象，或者只带一个认得的功能。 */
function isTestRequest(req: unknown): req is TestConnectionRequest {
  if (isEmptyRequest(req)) return true;
  if (typeof req !== "object" || req === null || Array.isArray(req)) return false;
  const keys = Object.keys(req);
  return keys.length === 1 && keys[0] === "feature" && FEATURES.includes((req as { feature?: unknown }).feature);
}

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
    "auto.resume": {
      senders: ["panel", "page"],
      pages: ["options"],
      validate: isEmptyRequest,
      async handler() {
        if (!auto) return ok({});
        await auto.resume();
        // 恢复以后把已经开着的视频页排进来，不等下一个标签页事件。
        void auto.consider().catch(() => undefined);
        return ok({});
      },
    },
  };
}
