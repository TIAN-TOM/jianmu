// 模型能力：从 Anthropic 的模型列表读出每个模型支持的 thinking 类型、effort 档位、
// 结构化输出和 max_tokens 上限，按 API 地址缓存在本机存储里。
// 协议层有能力数据时按能力发参数，没有时退回按型号名判断。
//
// OpenAI 的模型列表不返回能力字段，Responses 用的是协议层里的兼容表，
// 这里只负责把它的型号名列出来。
//
// 设置页「拉取模型列表」和后台都会写这份缓存：后台在缓存过期或缺失时自己拉一次，
// 免得用户没点过拉取就一直用不上能力数据。
import { NO_CLEAR_GUARD, type ClearEpoch, type ClearGuard } from "../clear-guard.ts";
import { dataConsentGiven, type DataConsentRules, type StoredDataConsent } from "../consent.ts";
import { CAPABILITY_STORAGE_KEY } from "../../shared/names.ts";
import {
  buildModelsRequest,
  KEYED_FETCH_REDIRECT,
  keyedHttpError,
  parseModelsResponse,
  PROTOCOLS,
  rejectRedirect,
  type AiSettings,
  type ClaudeCapabilities,
  type ModelsRequest,
  type ProviderError,
  type RedirectProbe,
} from "./provider/index.ts";

export { CAPABILITY_STORAGE_KEY };
// 能力很少变，但新型号上线、旧型号调整都要能跟上，一天刷新一次。
export const TTL_MS = 24 * 60 * 60 * 1000;
// 拉取失败（比如兼容网关没有模型列表）时先别每个请求都重试，一小时后再试。
export const FAILURE_TTL_MS = 60 * 60 * 1000;
// 官方每页上限 1000，通常一页就够；页数封顶，防着服务端的游标原地打转。
export const PAGE_LIMIT = 1000;
const MAX_PAGES = 10;
// 只留最近用过的几个地址，切换过的旧地址自然淘汰。
const MAX_CACHED_URLS = 8;
const FETCH_TIMEOUT_MS = 15_000;
// 能力表里 effort 各档的键，按从低到高排。
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);

interface SupportFlag {
  readonly supported?: unknown;
}

type EffortInfo = SupportFlag & {
  readonly [level in (typeof EFFORT_LEVELS)[number]]?: SupportFlag;
};

/** 模型列表里一项用得到的部分。来自服务方，形状不可信，读取的地方都留着判断。 */
interface ModelInfo {
  readonly id?: unknown;
  readonly max_tokens?: unknown;
  readonly capabilities?: {
    readonly thinking?: SupportFlag & {
      readonly types?: {
        readonly disabled?: SupportFlag;
        readonly between_tools?: SupportFlag;
        readonly adaptive?: SupportFlag;
      };
    };
    readonly effort?: EffortInfo;
    readonly structured_outputs?: SupportFlag;
  } | null;
}

interface ModelsPage {
  readonly data?: unknown;
  readonly has_more?: unknown;
  readonly last_id?: unknown;
}

/** 按模型名索引的能力。 */
export type ModelCapabilityMap = Record<string, ClaudeCapabilities>;

export interface ModelListing {
  readonly ids: string[];
  readonly capabilities: ModelCapabilityMap;
}

/** 发 GET：成功返回响应数据，失败抛出带 status 的错误。 */
export type ModelsSend = (request: ModelsRequest, settings?: AiSettings) => Promise<unknown>;

/** 每一页发出之前都核对过数据说明同意的 GET，只能由 createConsentGuardedGetter 造出来。 */
export type ConsentGuardedSend = ModelsSend & { readonly consentGuarded: true };

export interface ConsentGuardDeps {
  readonly getSettings: () => Promise<StoredDataConsent>;
  readonly settingsRules: DataConsentRules & { readonly dataConsentError: string };
  readonly send: ModelsSend;
}

/** 这里只用响应的这几项，真实的 Response 和测试替身都满足。 */
export interface JsonResponse extends RedirectProbe {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}

export interface JsonFetchInit {
  readonly headers: ModelsRequest["headers"];
  readonly redirect: typeof KEYED_FETCH_REDIRECT;
  readonly signal: AbortSignal;
}

export type JsonFetch = (url: string, init: JsonFetchInit) => Promise<JsonResponse>;

/** 能力缓存用的存储区，读写失败时当作没有缓存。 */
export interface CapabilityStorage {
  readonly get: (key: string) => Promise<Record<string, unknown>>;
  readonly set: (items: Record<string, unknown>) => Promise<unknown>;
}

interface CacheEntry {
  readonly fetchedAt?: number;
  readonly models?: ModelCapabilityMap;
  readonly failed?: boolean;
}

export interface CapabilityLookup {
  readonly fresh: boolean;
  readonly model: ClaudeCapabilities | null;
}

export interface CapabilitySaveOptions {
  readonly failed?: boolean;
  readonly since?: ClearEpoch | undefined;
}

export interface CapabilityCache {
  readonly lookup: (settings: Pick<AiSettings, "aiBaseUrl" | "aiModel">) => Promise<CapabilityLookup>;
  readonly save: (
    settings: Pick<AiSettings, "aiBaseUrl">,
    models: ModelCapabilityMap | null | undefined,
    options?: CapabilitySaveOptions,
  ) => Promise<boolean>;
}

export interface CapabilityCacheDeps {
  readonly storage: CapabilityStorage;
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
  readonly clearGuard?: ClearGuard | undefined;
}

export type CapabilityResolverDeps = CapabilityCacheDeps & {
  readonly log?: ((...args: unknown[]) => void) | undefined;
  readonly send: ConsentGuardedSend;
};

export type CapabilityResolver = (
  settings: AiSettings | null | undefined,
) => Promise<ClaudeCapabilities | null>;

/**
 * 把一个 ModelInfo 压成请求要用的几项。capabilities 为 null（服务没给）时返回 null，
 * 由调用方退回按型号名判断。max_tokens 为 0 或缺失时记 0，表示不知道上限。
 */
export function parseModelCapabilities(item: unknown): ClaudeCapabilities | null {
  const info = item as ModelInfo | null | undefined;
  const caps = info?.capabilities;
  if (!caps || typeof caps !== "object") return null;
  const supported = (node: SupportFlag | undefined): boolean => node?.supported === true;
  const types = caps.thinking?.types || {};
  return {
    maxTokens: Number(info?.max_tokens) > 0 ? Math.floor(Number(info?.max_tokens)) : 0,
    thinking: {
      // 文档写明：不支持思考的模型，disabled 也是 true。
      disabled: supported(types.disabled) || caps.thinking?.supported === false,
      betweenTools: supported(types.between_tools),
      adaptive: supported(types.adaptive),
    },
    efforts: supported(caps.effort)
      ? EFFORT_LEVELS.filter((level) => supported(caps.effort?.[level]))
      : [],
    structuredOutputs: supported(caps.structured_outputs),
  };
}

/**
 * 列出模型名和各模型的能力。send(request, settings) 发 GET，成功返回响应数据，
 * 失败抛出带 status 的错误。Anthropic 按 has_more 和 last_id 翻页；
 * OpenAI 兼容的两种协议只发一次。返回 { ids, capabilities }，capabilities 按模型名索引。
 * 每一页都带着密钥，所以只收核对过同意的 GET：途中取消了确认，后面的页就不再发。
 */
export async function listModels({
  settings,
  send,
}: {
  readonly settings: AiSettings;
  readonly send: ConsentGuardedSend;
}): Promise<ModelListing> {
  if (settings.protocol !== PROTOCOLS.ANTHROPIC) {
    const data = await send(buildModelsRequest(settings), settings);
    return { ids: parseModelsResponse(data), capabilities: {} };
  }
  const items: (ModelInfo | null | undefined)[] = [];
  let afterId = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = (await send(
      buildModelsRequest(settings, { limit: PAGE_LIMIT, afterId }),
      settings,
    )) as ModelsPage | null | undefined;
    if (Array.isArray(data?.data)) items.push(...data.data);
    const next = typeof data?.last_id === "string" ? data.last_id : "";
    if (!data?.has_more || !next || next === afterId) break;
    afterId = next;
  }
  const capabilities: ModelCapabilityMap = {};
  for (const item of items) {
    const id = item?.id;
    if (typeof id !== "string" || !id) continue;
    const parsed = parseModelCapabilities(item);
    if (parsed) capabilities[id] = parsed;
  }
  return { ids: parseModelsResponse({ data: items }), capabilities };
}

/**
 * 按 API 地址存取能力缓存。存储读写失败时当作没有缓存，不影响请求本身。
 * clearGuard：后台传入清除本机数据的闸门。save 的 since 是拉列表前记下的
 * 清除代数，这期间清除了缓存就不写，读改写整段登记在闸门里。
 */
export function createCapabilityCache({
  storage,
  now = () => Date.now(),
  ttlMs = TTL_MS,
  clearGuard = NO_CLEAR_GUARD,
}: CapabilityCacheDeps): CapabilityCache {
  async function readAll(): Promise<Record<string, CacheEntry>> {
    try {
      const stored = (await storage.get(CAPABILITY_STORAGE_KEY))?.[CAPABILITY_STORAGE_KEY];
      return stored && typeof stored === "object" ? (stored as Record<string, CacheEntry>) : {};
    } catch {
      return {};
    }
  }

  return {
    /**
     * fresh 为 false 表示缺失或过期，该重新拉了；model 是当前模型的能力，
     * 列表里没有这个模型或服务没给能力时为 null。
     */
    async lookup(settings) {
      const entry = (await readAll())[settings.aiBaseUrl];
      const age = now() - Number(entry?.fetchedAt || 0);
      const fresh = Boolean(entry) && age >= 0 && age < (entry?.failed ? FAILURE_TTL_MS : ttlMs);
      return { fresh, model: (fresh && entry?.models?.[settings.aiModel]) || null };
    },
    // 返回有没有写进去：清除过了、或者存储出错都回 false。
    async save(settings, models, { failed = false, since } = {}) {
      try {
        return await clearGuard.track(async () => {
          if (clearGuard.clearedSince(since, "cache")) return false;
          const all = await readAll();
          all[settings.aiBaseUrl] = {
            fetchedAt: now(),
            models: models || {},
            ...(failed ? { failed: true } : {}),
          };
          const kept = Object.entries(all)
            .sort((a, b) => Number(b[1]?.fetchedAt || 0) - Number(a[1]?.fetchedAt || 0))
            .slice(0, MAX_CACHED_URLS);
          await storage.set({ [CAPABILITY_STORAGE_KEY]: Object.fromEntries(kept) });
          return true;
        });
      } catch {
        // 存不进去下次再拉，能力数据只是锦上添花。
        return false;
      }
    },
  };
}

/**
 * 后台用的 GET：带超时，不跟随重定向，非 2xx 抛出带 status 的错误。
 * 请求带着密钥，这两条约定和模型调用一样，见 provider/keyed.ts。
 */
export function createJsonGetter(fetchImpl: JsonFetch, timeoutMs = FETCH_TIMEOUT_MS): ModelsSend {
  return async (request, settings) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(request.url, {
        headers: request.headers,
        redirect: KEYED_FETCH_REDIRECT,
        signal: controller.signal,
      });
      rejectRedirect(response, settings?.aiBaseUrl);
      // 错误响应的 body 可能不是 JSON，按状态码报错；2xx 读不出来就是这次失败了，不能当成空列表缓存。
      const data = response.ok ? await response.json() : await response.json().catch(() => ({}));
      if (!response.ok) throw keyedHttpError(data, response.status, settings);
      return data;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * 查模型能力要带着密钥翻页读模型列表。用户在途中取消了数据说明的确认，后面的页就不再发。
 * 设置里的同意版本和指纹由读设置时规整好，这里只比对。
 */
export function createConsentGuardedGetter({ getSettings, settingsRules, send }: ConsentGuardDeps): ConsentGuardedSend {
  const guarded: ModelsSend = async (request, settings) => {
    if (!dataConsentGiven(await getSettings(), settingsRules)) {
      const error: ProviderError = new Error(settingsRules.dataConsentError);
      error.code = "NO_DATA_CONSENT";
      throw error;
    }
    return send(request, settings);
  };
  return Object.assign(guarded, { consentGuarded: true as const });
}

/**
 * 后台的能力查询：先看缓存，缺失或过期就拉一次列表再存。同一个地址同时只拉一次，
 * 几个分块并发请求时不会各拉各的。拉取失败返回 null，请求照样按型号名的规则发。
 * 只有 Anthropic 协议有能力数据，其余协议直接返回 null。
 */
export function createCapabilityResolver(deps: CapabilityResolverDeps): CapabilityResolver {
  const { storage, now, ttlMs, clearGuard = NO_CLEAR_GUARD, log = () => {}, send } = deps;
  const cache = createCapabilityCache({ storage, now, ttlMs, clearGuard });
  const inflight = new Map<string, Promise<ModelCapabilityMap>>();

  async function refresh(settings: AiSettings): Promise<ModelCapabilityMap> {
    // 拉列表要等网络，这期间清除了缓存就不再存回去。
    const since = clearGuard.epoch();
    try {
      const { capabilities } = await listModels({ settings, send });
      await cache.save(settings, capabilities, { since });
      return capabilities;
    } catch (error) {
      // 用户取消了数据说明的确认：不算服务的错，不记失败，交给调用方拦下请求。
      if ((error as ProviderError | null | undefined)?.code === "NO_DATA_CONSENT") throw error;
      log("[jianmu] 读取模型能力失败，按型号名判断：", error);
      await cache.save(settings, {}, { failed: true, since });
      return {};
    }
  }

  return async function capabilitiesFor(settings) {
    if (settings?.protocol !== PROTOCOLS.ANTHROPIC) return null;
    const cached = await cache.lookup(settings);
    if (cached.fresh) return cached.model;
    const key = settings.aiBaseUrl;
    let pending = inflight.get(key);
    if (!pending) {
      pending = refresh(settings).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const capabilities = await pending;
    return capabilities[settings.aiModel] || null;
  };
}
