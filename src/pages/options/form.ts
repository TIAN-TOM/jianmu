// 设置页「AI 服务」表单的纯逻辑：从存着的设置填表、换服务商、拼出保存用的设置。不碰存储和浏览器接口。
import type { LoadedSettings } from "../../platform/settings-store.ts";
import {
  CUSTOM_PRESET_ID,
  featureModelsOwnerOf,
  FEATURE_MODEL_SLOTS,
  originOf,
  presetById,
  REGION_PRESETS,
  type AnalysisChunkMode,
  type FeatureSlotId,
  type SettingsInput,
} from "../../shared/settings-schema.ts";

export interface AiForm {
  readonly presetId: string;
  readonly protocol: string;
  readonly aiBaseUrl: string;
  readonly aiApiKey: string;
  /** 用户在这一页里亲手填过密钥：保存时归到表单当前的地址。没填过的按已存那把的来源核对。 */
  readonly keyTyped: boolean;
  readonly aiModel: string;
  readonly featureModels: Readonly<Partial<Record<FeatureSlotId, string>>>;
  readonly analysisChunkMode: AnalysisChunkMode;
  readonly rememberApiKey: boolean;
}

export function formOf(settings: LoadedSettings): AiForm {
  return {
    presetId: settings.presetId,
    protocol: settings.protocol,
    aiBaseUrl: settings.aiBaseUrl,
    aiApiKey: settings.aiApiKey,
    keyTyped: false,
    aiModel: settings.aiModel,
    featureModels: { ...settings.featureModels },
    analysisChunkMode: settings.analysisChunkMode,
    rememberApiKey: settings.rememberApiKey,
  };
}

/**
 * 换服务商：预设的地址和协议跟着换，模型换成预设给的；密钥只属于原来的来源，换到别家就清空，换回来再填上。
 * 按功能选的模型各家不通用，归属变了就清空。自定义保留表单里现有的地址和协议，让用户自己改。
 */
export function withPreset(form: AiForm, presetId: string, saved: LoadedSettings): AiForm {
  const preset = presetById(presetId);
  if (!preset) return form;
  const custom = preset.id === CUSTOM_PRESET_ID;
  const next: AiForm = {
    ...form,
    presetId: preset.id,
    protocol: custom ? form.protocol : preset.protocol,
    aiBaseUrl: custom ? form.aiBaseUrl : preset.baseUrl,
    aiModel: preset.id === saved.presetId ? saved.aiModel : preset.model,
  };
  return rebound(form, next, saved);
}

/** 自定义地址或协议改了以后：来源变了，密钥和按功能选的模型跟着走。 */
export function withAddress(form: AiForm, patch: Pick<AiForm, "aiBaseUrl"> | Pick<AiForm, "protocol">, saved: LoadedSettings): AiForm {
  return rebound(form, { ...form, ...patch }, saved);
}

function rebound(before: AiForm, next: AiForm, saved: LoadedSettings): AiForm {
  const origin = originOf(next.aiBaseUrl);
  let key = { aiApiKey: next.aiApiKey, keyTyped: next.keyTyped };
  if (origin !== originOf(before.aiBaseUrl)) {
    // 回到已存密钥所属的来源就把它填回来；别的来源一律清空，免得把这家的密钥发给那家。
    key = origin !== null && origin === saved.aiApiKeyOrigin ? { aiApiKey: saved.aiApiKey, keyTyped: false } : { aiApiKey: "", keyTyped: false };
  }
  const owner = featureModelsOwnerOf(next);
  const models = owner === featureModelsOwnerOf(before) ? next.featureModels : {};
  return { ...next, ...key, featureModels: models };
}

/** 保存用的完整设置：从存着的设置补全表单上没有的字段，密钥来源和按功能选的模型归属按表单当前的地址写明。 */
export function settingsInput(form: AiForm, saved: LoadedSettings): SettingsInput {
  const { keyTyped, ...fields } = form;
  return {
    ...saved,
    ...fields,
    aiApiKeyOrigin: keyTyped ? (originOf(form.aiBaseUrl) ?? "") : "",
    featureModels: { ...form.featureModels },
    featureModelsOwner: featureModelsOwnerOf(form),
  };
}

/** 另选了模型的功能，测试全部模型时逐个测。 */
export function chosenFeatures(form: AiForm): FeatureSlotId[] {
  return FEATURE_MODEL_SLOTS.filter(({ id }) => (form.featureModels[id] ?? "").trim() !== "").map(({ id }) => id);
}

/** 国内／海外快捷选择：还没填密钥、停在快捷预设之一、没按功能另选模型时才显示。 */
export function showsRegionChooser(saved: LoadedSettings): boolean {
  if (saved.aiApiKey) return false;
  if (Object.keys(saved.featureModels).length > 0) return false;
  return REGION_PRESETS.some((region) => region.presetId === saved.presetId);
}
