// 设置页「AI 服务」表单的纯逻辑：从存着的设置填表、换服务商、拼出保存用的设置、推理强度旁边的说明。不碰存储和浏览器接口。
// 表单只装要点「保存」才生效的几项：服务商、地址、密钥、模型、记住密钥。推理强度和概览分块即改即存，不在表单里。
import type { LoadedSettings } from "../../platform/settings-store.ts";
import type { EffortPreviewItem } from "../../shared/messages/ai.ts";
import {
  CUSTOM_PRESET_ID,
  featureModelsOwnerOf,
  FEATURE_MODEL_SLOTS,
  originOf,
  presetById,
  REGION_PRESETS,
  type FeatureSlotId,
  type SettingsInput,
} from "../../shared/settings-schema.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { textOf } from "./text.ts";

export interface AiForm {
  readonly presetId: string;
  readonly protocol: string;
  readonly aiBaseUrl: string;
  readonly aiApiKey: string;
  /** 用户在这一页里亲手填过密钥：保存时归到表单当前的地址。没填过的按已存那把的来源核对。 */
  readonly keyTyped: boolean;
  readonly aiModel: string;
  readonly featureModels: Readonly<Partial<Record<FeatureSlotId, string>>>;
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
    rememberApiKey: settings.rememberApiKey,
  };
}

/** 两份表单的服务商、协议、地址和密钥都一样：「要不要记住密钥」问的还是同一把。 */
export const sameCredentials = (a: AiForm, b: AiForm): boolean =>
  a.presetId === b.presetId && a.protocol === b.protocol && a.aiBaseUrl === b.aiBaseUrl && a.aiApiKey === b.aiApiKey;

/**
 * 保存完要不要问「记住密钥」：存下的有密钥、没记住也没问过，而且眼下的表单还是刚存的那一把、勾选框没被勾上。
 * 保存收尾要等后台回话，这期间用户可能改了密钥、换了服务商或者自己勾了记住：都以眼下的表单为准，不再问。
 */
export const asksRememberAfterSave = (now: AiForm | null, written: LoadedSettings): boolean =>
  written.aiApiKey !== "" && !written.rememberApiKey && !written.rememberKeyAsked && now !== null && !now.rememberApiKey && sameCredentials(now, formOf(written));

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

/** 保存用的完整设置：从存着的设置补全表单上没有的字段（含推理强度和概览分块），密钥来源和按功能选的模型归属按表单当前的地址写明。 */
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

/**
 * 国内／海外快捷选择：还没填密钥、停在快捷预设之一、没按功能另选模型、也没同意过数据说明时才显示。
 * 同意过的人配过一轮了：密钥随重启清空以后不再摆，免得点一下把服务商换掉。
 */
export function showsRegionChooser(saved: LoadedSettings): boolean {
  if (saved.aiApiKey) return false;
  if (saved.dataConsentVersion > 0) return false;
  if (Object.keys(saved.featureModels).length > 0) return false;
  return REGION_PRESETS.some((region) => region.presetId === saved.presetId);
}

const trimmedModels = (models: AiForm["featureModels"]): string =>
  JSON.stringify(FEATURE_MODEL_SLOTS.map(({ id }) => (models[id] ?? "").trim()));

/**
 * 表单上的服务商、地址、协议或模型和已保存的不一样。实际档位是后台按已保存的服务和模型算的，
 * 这时算出来的对不上表单，先不标。
 */
export function serviceChanged(form: AiForm, saved: LoadedSettings): boolean {
  return (
    form.presetId !== saved.presetId ||
    form.protocol !== saved.protocol ||
    form.aiBaseUrl !== saved.aiBaseUrl ||
    form.aiModel.trim() !== saved.aiModel.trim() ||
    trimmedModels(form.featureModels) !== trimmedModels(saved.featureModels)
  );
}

/** 实际生效的档位和选的不一样时，旁边那一句；一样、或者选关而服务说不准时不说。 */
export function effortNoteText(item: Pick<EffortPreviewItem, "requested" | "effective" | "note">, lang: UiLang): string | null {
  const { requested, effective, note } = item;
  const t = textOf(lang).efforts;
  if (note === "cannot-disable") return t.cannotDisable(t.labels[effective]);
  if (note === "unknown") return requested === "off" ? null : t.serviceDecides;
  if (requested !== effective && effective === "off") return t.alwaysOff;
  if (requested !== effective) return t.missingLevel(t.labels[requested], t.labels[effective]);
  return null;
}

/**
 * 这项功能最近一次请求的用量那一行。数字都是服务回报的；思考没单独报时照实说，不估算；档位写那次实际按的，
 * 扩展设不了时写由服务决定；那次用的模型和现在的不一样时带上模型名。没请求过时不说。
 * 服务报的合计比输入加输出多时在最后写上：多出来的那部分服务没说是什么，照原样摆出来，不替它算成思考；一样多时不重复写。
 */
export function usageText(item: Pick<EffortPreviewItem, "model" | "lastUsage">, lang: UiLang): string | null {
  const last = item.lastUsage;
  if (!last) return null;
  const t = textOf(lang).efforts;
  const tokens = (count: number): string => count.toLocaleString(t.numberLocale);
  const { input, output, reasoning, total } = last.usage;
  const showTotal = total !== undefined && (input === undefined || output === undefined || total > input + output);
  const level = last.note === "unknown" ? t.usageLevelByService : t.labels[last.effort];
  const head = t.usageHead(level, last.model === item.model ? null : last.model);
  const parts = [...(input === undefined ? [] : [t.usageInput(tokens(input))]), ...(output === undefined ? [] : [t.usageOutput(tokens(output))])];
  if (!parts.length && reasoning === undefined && !showTotal) return t.usageLine(head, t.usageNone);
  parts.push(reasoning === undefined ? t.usageReasoningMissing : t.usageReasoning(tokens(reasoning)));
  if (showTotal) parts.push(t.usageTotal(tokens(total)));
  return t.usageLine(head, parts.join(" · "));
}
