// 测试用的设置规则：校验、规整、按功能换模型、同意版本和默认超时，口径和设置模块一致。
// 只写传输层走得到的部分，外观、分块这些设置项不在这里。
import { presetById, resolveEndpoint, validateBaseUrl, type BaseUrlCheck } from "../../src/core/ai/provider/endpoint.ts";
import type { AiSettings } from "../../src/core/ai/provider/index.ts";
import type { TransportSettingsRules } from "../../src/core/ai/transport/index.ts";

export const CUSTOM_PRESET_ID = "custom";
export const DATA_CONSENT_VERSION = 2;
export const DATA_CONSENT_ERROR = "请先在设置页「AI 服务」一节读一下数据说明，勾选「我已了解」。";
export const AI_TIMEOUT_SECONDS = 120;

// 预设的默认模型，只有这两家写了。
const DEFAULT_MODELS: Readonly<Record<string, string>> = {
  anthropic: "claude-sonnet-5-5",
  deepseek: "deepseek-v4-flash",
};
const FEATURES = ["analysis", "verdict", "rewrite", "qa", "notes", "explain"] as const;
const MAX_MODEL_CHARS = 200;

export interface SettingsInput {
  readonly presetId?: string | undefined;
  readonly protocol?: string | undefined;
  readonly aiApiKey?: string | undefined;
  readonly aiApiKeyOrigin?: string | null | undefined;
  readonly aiBaseUrl?: string | undefined;
  readonly aiModel?: string | undefined;
  readonly featureModels?: Readonly<Record<string, unknown>> | undefined;
  readonly featureModelsOwner?: string | undefined;
  readonly dataConsentVersion?: number | undefined;
}

export interface NormalizedSettings extends AiSettings {
  readonly presetId: string;
  readonly aiApiKeyOrigin: string;
  readonly featureModels: Readonly<Record<string, string>>;
  readonly featureModelsOwner: string;
  readonly dataConsentVersion: number;
}

export function originOf(baseUrl: string): string | null {
  const result = validateBaseUrl(baseUrl);
  return result.ok ? result.origin : null;
}

// 密钥只属于填写它时的 API 来源，来源对不上就当作没填。
function bindApiKey(source: SettingsInput, checked: BaseUrlCheck): { key: string; origin: string } {
  const key = typeof source.aiApiKey === "string" ? source.aiApiKey.trim() : "";
  const recorded = typeof source.aiApiKeyOrigin === "string" ? source.aiApiKeyOrigin : "";
  if (!key) return { key: "", origin: "" };
  if (!checked.ok) return { key, origin: recorded };
  if (!recorded || originOf(recorded) === checked.origin) return { key, origin: checked.origin };
  return { key: "", origin: "" };
}

function normalizeFeatureModels(input: SettingsInput["featureModels"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const id of FEATURES) {
    const raw = Object.hasOwn(input, id) ? input[id] : "";
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) out[id] = value.slice(0, MAX_MODEL_CHARS);
  }
  return out;
}

// 按功能选的模型只属于填写时的服务商和地址，换了就清空。
function bindFeatureModels(
  source: SettingsInput,
  presetId: string,
  checked: BaseUrlCheck,
): { models: Record<string, string>; owner: string } {
  const models = normalizeFeatureModels(source.featureModels);
  if (!Object.keys(models).length) return { models, owner: "" };
  const recorded = typeof source.featureModelsOwner === "string" ? source.featureModelsOwner : "";
  if (!checked.ok) return { models, owner: recorded };
  const owner = `${presetId}|${checked.origin}`;
  if (!recorded || recorded === owner) return { models, owner };
  return { models: {}, owner: "" };
}

export function normalize(input: SettingsInput = {}): NormalizedSettings {
  const source: SettingsInput = input && typeof input === "object" ? input : {};
  const presetId = presetById(source.presetId)?.id ?? "anthropic";
  const { protocol, aiBaseUrl } = resolveEndpoint(source);
  const rawModel =
    typeof source.aiModel === "string" && source.aiModel.trim()
      ? source.aiModel.trim()
      : (DEFAULT_MODELS[presetId] ?? "");
  const checked = validateBaseUrl(aiBaseUrl, protocol);
  const apiKey = bindApiKey(source, checked);
  const featureModels = bindFeatureModels(source, presetId, checked);
  return {
    presetId,
    protocol,
    aiApiKey: apiKey.key,
    aiApiKeyOrigin: apiKey.origin,
    aiBaseUrl,
    aiModel: rawModel.slice(0, MAX_MODEL_CHARS),
    featureModels: featureModels.models,
    featureModelsOwner: featureModels.owner,
    dataConsentVersion:
      Number.isInteger(source.dataConsentVersion) && (source.dataConsentVersion as number) > 0
        ? (source.dataConsentVersion as number)
        : 0,
  };
}

export function validate(settings: SettingsInput): {
  ok: boolean;
  errors: string[];
  settings: NormalizedSettings;
} {
  const normalized = normalize(settings);
  const errors: string[] = [];
  if (!normalized.aiApiKey) errors.push("请填写 API 密钥（浏览器重启、扩展更新后要重新填）。");
  if (normalized.dataConsentVersion !== DATA_CONSENT_VERSION) errors.push(DATA_CONSENT_ERROR);
  const base = validateBaseUrl(normalized.aiBaseUrl, normalized.protocol);
  if (!base.ok) errors.push(base.error);
  if (!normalized.aiModel) errors.push("请填写模型名称，或点击「拉取模型列表」进行选择。");
  return { ok: errors.length === 0, errors, settings: normalized };
}

// 某项功能实际要用的模型：设置了就用它，没设置或功能名认不出时用默认模型。
function modelForFeature(settings: SettingsInput, feature: string | undefined): string {
  const normalized = normalize(settings);
  const override =
    feature !== undefined && Object.hasOwn(normalized.featureModels, feature)
      ? normalized.featureModels[feature]
      : "";
  return override || normalized.aiModel;
}

export function withFeatureModel<T extends AiSettings>(settings: T, feature: string | undefined): T {
  const model = modelForFeature(settings, feature);
  return model === settings?.aiModel ? settings : { ...settings, aiModel: model };
}

export const settingsRules: TransportSettingsRules = {
  validate,
  normalize,
  withFeatureModel,
  dataConsentVersion: DATA_CONSENT_VERSION,
  dataConsentError: DATA_CONSENT_ERROR,
  timeoutSeconds: AI_TIMEOUT_SECONDS,
};
