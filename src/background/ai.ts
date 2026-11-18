// 模型服务的接线：传输层按设置规则建，主机权限只查不申请，参数放宽记在会话存储里，模型能力只经核对过同意的 GET 读，
// 写缓存都过清除闸门。路由和服务只拿到这里给的几个入口，拿不到不核对同意的发送。
import {
  createCapabilityCache,
  createCapabilityResolver,
  createConsentGuardedGetter,
  createJsonGetter,
  listModels as listModelPages,
  resolveCapabilities,
  type JsonFetch,
  type JsonFetchInit,
  type JsonResponse,
} from "../core/ai/capabilities.ts";
import {
  PROTOCOLS,
  createRelaxMemory,
  hostOf,
  planEffort,
  type AiSettings,
  type ClaudeCapabilities,
  type EffortPlan,
  type ProviderError,
} from "../core/ai/provider/index.ts";
import {
  aiErrorResponse,
  createAiTransport,
  type AiFetchInit,
  type AiTransport,
  type CompletionRequest,
  type CompletionResult,
  type TransportResponse,
  type TransportSettingsRules,
} from "../core/ai/transport/index.ts";
import type { ClearGuard } from "../core/clear-guard.ts";
import { fail, ok, type Failure, type Result } from "../core/errors.ts";
import { AI_ERROR_TEXT, type AiErrorCode } from "../core/errors/ai.ts";
import type { Effort } from "../core/notes/records.ts";
import { sha256Hex } from "../core/task-keys.ts";
import { budgetEffort, type FrozenGen } from "../core/tasks.ts";
import type { Permissions } from "../platform/permissions.ts";
import type { LoadedSettings, SettingsStore } from "../platform/settings-store.ts";
import type { ExtensionStorage } from "../platform/storage.ts";
import type {
  ConfigCheckView,
  EffortPreviewItem,
  EffortPreviewView,
  ModelListView,
  TestConnectionView,
} from "../shared/messages/ai.ts";
import {
  EFFORT_TIMEOUT_SECONDS,
  effortForFeature,
  FEATURE_MODEL_SLOTS,
  modelForFeature,
  originOf,
  settingsRules as SETTINGS_RULES,
  validateForSave,
  type FeatureSlotId,
} from "../shared/settings-schema.ts";

/** 模型请求和模型列表共用的 fetch：浏览器的 fetch 两种都满足。 */
export type ModelServiceFetch = (url: string, init: AiFetchInit | JsonFetchInit) => Promise<TransportResponse & JsonResponse>;

/** 构建时内联的提示词全文，按文件名取。 */
export type PromptTable = Readonly<Record<string, string>>;

export interface AiWiringDeps {
  readonly settings: Pick<SettingsStore, "load">;
  readonly storage: Pick<ExtensionStorage, "local" | "session">;
  readonly permissions: Pick<Permissions, "contains">;
  readonly fetch: ModelServiceFetch;
  readonly clearGuard: ClearGuard;
  readonly prompts: PromptTable;
  /** 默认是设置模块的那一份；超时、同意版本都按它来。 */
  readonly settingsRules?: TransportSettingsRules;
  readonly now?: () => number;
}

/** 服务发模型请求的入口：一个任务一份，按任务创建时取定的配置发。 */
export interface TaskAi {
  readonly requestAiCompletion: (request: Omit<CompletionRequest, "feature">) => Promise<CompletionResult>;
}

export interface AiWiring {
  /** 配置够不够发起一次请求。只回能不能用和给用户看的提示，不带设置和密钥。 */
  readonly configCheck: () => Promise<ConfigCheckView>;
  /** 按当前设置发一次模型请求，功能另选了模型就用那个；推理强度按请求里给的，不给就是关。 */
  readonly requestAiCompletion: (request: CompletionRequest) => Promise<CompletionResult>;
  /** 建任务时取定这项功能的生成配置：服务地址、实际要用的模型、实际生效的推理档位、提示词版本。档位按发请求时同一份模型能力算。 */
  readonly freeze: (feature: FeatureSlotId) => Promise<FrozenGen>;
  /** 给一个任务的入口：地址、模型、推理档位按冻结的那份，跑到一半改设置不跟着变。 */
  readonly forTask: (frozen: FrozenGen) => TaskAi;
  /**
   * 每项功能实际生效的推理档位，设置页显示用。只用本机的映射表、已缓存的模型能力和放宽记忆算，
   * 不发任何请求。requested 是表单上还没保存的选择，没给的功能按已保存的设置。
   */
  readonly effortPreview: (requested?: Readonly<Partial<Record<FeatureSlotId, Effort>>>) => Promise<EffortPreviewView>;
  /** 按已保存的设置拉模型列表，顺带把模型能力存起来。 */
  readonly listModels: () => Promise<Result<ModelListView>>;
  /** 发一个很小的请求看模型能不能回话。只发一次，不加码重试，参数被拒时照样放宽。 */
  readonly testConnection: (feature?: FeatureSlotId) => Promise<Result<TestConnectionView>>;
  /** 服务要用的提示词。读不到就报错，不发空提示词。 */
  readonly prompt: (file: string) => string;
}

// 关不掉思考的模型，思考也算在预算里，给少了可能还没写出正文就用完了。上限本身不收费，按实际生成计费。
const TEST_MAX_TOKENS = 1024;
const TEST_REPLY_CHARS = 30;
const TEST_MESSAGES = [{ role: "user" as const, content: "回复两个字：可用" }];

const AI_CODES: ReadonlySet<string> = new Set(Object.keys(AI_ERROR_TEXT));

// 每项功能用哪份提示词；提示词的版本就是它全文的指纹，改了提示词，旧任务的结果不算等价。
const FEATURE_PROMPTS: Readonly<Record<FeatureSlotId, string>> = {
  analysis: "skim/chapters.md",
  verdict: "skim/verdict.md",
  rewrite: "study/translation.md",
  tidy: "study/tidy.md",
  qa: "common/qa.md",
  notes: "study/note-polish.md",
  explain: "study/explain.md",
};

function codedError(code: AiErrorCode, message: string): ProviderError {
  return Object.assign(new Error(message), { code });
}

/**
 * 传输层的错误换成结果。说明来自传输层，带密钥的地方已经脱敏；认不出的错误只回码，不带说明。
 * 模型服务的限流单独一个码，和视频网站的限流分开。
 */
export function aiFailure(error: unknown): Failure {
  const { error: raw, message } = aiErrorResponse(error);
  const code = raw === "RATE_LIMITED" ? "AI_RATE_LIMITED" : raw;
  return AI_CODES.has(code) && code !== "AI_REQUEST_FAILED" ? fail(code as AiErrorCode, message) : fail("AI_REQUEST_FAILED");
}

// 硬超时随档位放宽，和任务的保活预算用同一张表；关和低档用设置规则里的默认值。
function taskTimeoutMs(effort: Effort): number | undefined {
  return EFFORT_TIMEOUT_SECONDS[effort] > EFFORT_TIMEOUT_SECONDS.off ? EFFORT_TIMEOUT_SECONDS[effort] * 1000 : undefined;
}

// 冻结的地址和现在的对不上：密钥属于现在的地址，按冻结的地址取不到，当作没填，按配置错误收尾。
function frozenSettings(current: LoadedSettings, frozen: FrozenGen): LoadedSettings {
  const key = current.aiBaseUrl === frozen.baseUrl ? {} : { aiApiKey: "", aiApiKeyOrigin: "" };
  return { ...current, ...key, aiModel: frozen.model, featureModels: {} };
}

export function createAiWiring(deps: AiWiringDeps): AiWiring {
  const { settings, storage, permissions, clearGuard, prompts, now } = deps;
  const rules = deps.settingsRules ?? SETTINGS_RULES;
  const load = settings.load;

  // 只查不申请：申请权限要用户手势，只能在设置页里点。
  async function ensureHostPermission(baseUrl: string): Promise<void> {
    const origin = originOf(baseUrl);
    if (!origin) throw codedError("INVALID_BASE_URL", "API 地址不合法，请到设置页检查。");
    if (!(await permissions.contains(origin))) {
      throw codedError("NEED_HOST_PERMISSION", `扩展还没有访问 ${origin} 的权限。请打开设置页，点「保存并授权」。`);
    }
  }

  const jsonFetch: JsonFetch = deps.fetch;
  const consentedGet = createConsentGuardedGetter({ getSettings: load, settingsRules: rules, send: createJsonGetter(jsonFetch) });
  const capabilityCache = createCapabilityCache({ storage: storage.local, clearGuard, now });
  const shared = {
    ensureHostPermission,
    settingsRules: rules,
    fetch: deps.fetch,
    // 后台被回收后醒来不必重新挨一次参数被拒；关掉浏览器才清空。
    relaxMemory: createRelaxMemory({ storage: storage.session, clearGuard }),
    getModelCapabilities: createCapabilityResolver({ storage: storage.local, send: consentedGet, clearGuard, now }),
  };
  const build = (getSettings: () => Promise<AiSettings>, timeoutMs?: number): AiTransport =>
    createAiTransport({ ...shared, getSettings, timeoutMs });
  const transport = build(load);

  // 本机缓存里的模型能力，过期或没有就是 null，按型号名判断。
  async function cachedCapabilities(settings: LoadedSettings): Promise<ClaudeCapabilities | null> {
    return settings.protocol === PROTOCOLS.ANTHROPIC ? (await capabilityCache.lookup(settings)).model : null;
  }

  // 设置页预览只读本机，不像发请求前那样去拉列表。
  const localPlan = (current: LoadedSettings, model: string, requested: Effort): Promise<EffortPlan> =>
    planWith(current, model, requested, cachedCapabilities({ ...current, aiModel: model }));

  // 建任务时和发请求用同一个能力查询：缓存新鲜就用缓存，不新鲜时像发请求前那样拉一次（只有 Anthropic 协议会拉），
  // 拉回来进缓存，紧接着的请求直接命中，所以记下的档位就是请求实际用的档位。没有主机权限（只查不申请）、
  // 没同意数据说明、拉不到时按缓存或型号名算。
  const sendPlan = (current: LoadedSettings, model: string, requested: Effort): Promise<EffortPlan> => {
    const settings = { ...current, aiModel: model };
    const claude = Promise.resolve()
      .then(() => ensureHostPermission(settings.aiBaseUrl))
      .then(() => shared.getModelCapabilities(settings))
      .catch(() => cachedCapabilities(settings));
    return planWith(current, model, requested, claude);
  };

  async function planWith(
    current: LoadedSettings,
    model: string,
    requested: Effort,
    capabilities: Promise<ClaudeCapabilities | null>,
  ): Promise<EffortPlan> {
    const settings = { ...current, aiModel: model };
    const claude = await capabilities;
    await shared.relaxMemory.ready();
    const host = hostOf(current.aiBaseUrl);
    const relax = shared.relaxMemory.recall(settings, requested);
    const caps = resolveCapabilities({ protocol: current.protocol, host, model, claude, relax });
    return planEffort({ protocol: current.protocol, host, model, requested, caps });
  }

  async function listModels(): Promise<Result<ModelListView>> {
    try {
      const current = await load();
      const base = validateForSave(current);
      if (!base.ok) throw codedError("INVALID_BASE_URL", base.errors.join(" "));
      if (!current.aiApiKey) throw codedError("NO_AI_CONFIG", "请先在设置页填写 API 密钥。");
      await ensureHostPermission(current.aiBaseUrl);
      // 拉列表要等网络，这期间清除了缓存就不把能力写回去。
      const since = clearGuard.epoch();
      const { ids, capabilities } = await listModelPages({ settings: current, send: consentedGet });
      if (current.protocol === PROTOCOLS.ANTHROPIC) await capabilityCache.save(current, capabilities, { since });
      return ok({ ids });
    } catch (error) {
      return aiFailure(error);
    }
  }

  async function testConnection(feature?: FeatureSlotId): Promise<Result<TestConnectionView>> {
    try {
      const result = await transport.requestAiCompletion({
        feature,
        messages: TEST_MESSAGES,
        maxTokens: TEST_MAX_TOKENS,
        selfRetry: false,
      });
      const reply = result.text.trim().slice(0, TEST_REPLY_CHARS);
      return ok({ model: result.settings.aiModel, reply, ...(result.truncated ? { truncated: true as const } : {}) });
    } catch (error) {
      return aiFailure(error);
    }
  }

  const promptVersions = new Map<string, Promise<string>>();
  const promptVersion = (file: string): Promise<string> => {
    let version = promptVersions.get(file);
    if (!version) {
      version = sha256Hex(prompt(file)).then((hex) => hex.slice(0, 16));
      promptVersions.set(file, version);
    }
    return version;
  };

  function prompt(file: string): string {
    if (!Object.hasOwn(prompts, file)) throw new Error(`没有这份提示词：${file}`);
    return prompts[file] ?? "";
  }

  return {
    async configCheck() {
      const { ok: ready, errors } = rules.validate(await load());
      return { ready, errors: [...errors] };
    },
    requestAiCompletion: (request) => transport.requestAiCompletion(request),
    async freeze(feature) {
      const current = await load();
      const model = modelForFeature(current, feature);
      const requested = effortForFeature(current, feature);
      const { effective } = await sendPlan(current, model, requested);
      return {
        feature,
        baseUrl: current.aiBaseUrl,
        model,
        effort: effective,
        ...(effective === requested ? {} : { requestedEffort: requested }),
        promptVersion: await promptVersion(FEATURE_PROMPTS[feature]),
      };
    },
    forTask(frozen) {
      const effort = frozen.requestedEffort ?? frozen.effort;
      const bound = build(async () => frozenSettings(await load(), frozen), taskTimeoutMs(budgetEffort(frozen)));
      return { requestAiCompletion: (request) => bound.requestAiCompletion({ ...request, feature: frozen.feature, effort }) };
    },
    async effortPreview(requested = {}) {
      const current = await load();
      const items: EffortPreviewItem[] = [];
      for (const { id } of FEATURE_MODEL_SLOTS) {
        const model = modelForFeature(current, id);
        const plan = await localPlan(current, model, requested[id] ?? effortForFeature(current, id));
        items.push({ feature: id, model, requested: plan.requested, effective: plan.effective, ...(plan.note ? { note: plan.note } : {}) });
      }
      return { items };
    },
    listModels,
    testConnection,
    prompt,
  };
}
