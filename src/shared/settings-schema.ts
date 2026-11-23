// 设置的结构和规则：默认值、规整、校验、按功能选模型。读写存储在设置仓库里，这里不碰 chrome.*。
// 协议和地址只写在 core/ai/provider/endpoint.ts，这里按 id 补给界面用的内容，依赖方向是这里导入那边。
import { ANALYSIS_CHUNK_CHARS, ANALYSIS_SINGLE_CHARS } from "../core/ai/chunking.ts";
import {
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET as DEFAULT_ENDPOINT,
  ENDPOINT_PRESETS,
  isLocalBaseUrl,
  resolveEndpoint,
  validateBaseUrl,
  type BaseUrlCheck,
  type KnownEndpointPreset,
  type PresetId,
} from "../core/ai/provider/endpoint.ts";
import { EFFORT_BUDGETS, EFFORTS, isEffort } from "../core/ai/provider/effort.ts";
import type { AiSettings } from "../core/ai/provider/index.ts";
import type { TransportSettingsRules } from "../core/ai/transport/index.ts";
import type { Effort } from "../core/notes/records.ts";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_TABLE,
  ACTIVATION_VERSION,
  DATA_CONSENT_ERROR,
  DATA_CONSENT_FINGERPRINT,
  DATA_CONSENT_VERSION,
  dataConsentErrorText,
  dataConsentGiven,
  noticeStatus,
  type ActivationKind,
  type NoticeStatus,
} from "../core/consent.ts";
import { carryActivation } from "../core/consent-carry.ts";
import { isLanguageSetting, type LanguageSetting, type OutputLang } from "../core/output-lang.ts";
import { FRAME_SLOT } from "./frame-slot.ts";
import { settingsCheckText } from "./settings-text.ts";

export { CUSTOM_PRESET_ID };

// 显示名在设置页的文案表里（pages/options/text-zh.ts、text-en.ts），按 id 取。
interface PresetDetail {
  /** 只给默认的 Anthropic 和 DeepSeek 预置，其余留空，用户在模型列表里自己选。 */
  readonly model: string;
  /** 密钥页。 */
  readonly docsUrl: string;
}

export type ServicePreset = KnownEndpointPreset & PresetDetail;

const PRESET_DETAILS: Readonly<Record<PresetId, PresetDetail>> = {
  // 默认用 Sonnet：概览按块调用、批量生成会累积，Opus 留给用户自己选。
  anthropic: { model: "claude-sonnet-5-5", docsUrl: "https://platform.claude.com/settings/keys" },
  openai: { model: "", docsUrl: "https://platform.openai.com/api-keys" },
  deepseek: { model: "deepseek-flash", docsUrl: "https://platform.deepseek.com/api_keys" },
  gemini: { model: "", docsUrl: "https://aistudio.google.com/apikey" },
  moonshot: { model: "", docsUrl: "https://platform.kimi.com/console/api-keys" },
  zhipu: { model: "", docsUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys" },
  // 密钥页指向北京地域，和预设的地址一致。
  dashscope: { model: "", docsUrl: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key" },
  siliconflow: { model: "", docsUrl: "https://cloud.siliconflow.cn/account/ak" },
  openrouter: { model: "", docsUrl: "https://openrouter.ai/keys" },
  // 本机服务没有密钥页。
  ollama: { model: "", docsUrl: "" },
  [CUSTOM_PRESET_ID]: { model: "", docsUrl: "" },
};

const withDetail = (preset: KnownEndpointPreset): ServicePreset => ({ ...preset, ...PRESET_DETAILS[preset.id] });

export const PRESETS: readonly ServicePreset[] = Object.freeze(ENDPOINT_PRESETS.map(withDetail));

const DEFAULT_PRESET = withDetail(DEFAULT_ENDPOINT);

export const presetById = (id: unknown): ServicePreset | null => PRESETS.find((preset) => preset.id === id) ?? null;

// 设置页还没填密钥时给的快捷选择，国内在前。只帮着选预设，不判断用户所在地，
// 也不保证账户能开通：Anthropic 不对中国大陆、香港、澳门开放。
export const REGION_PRESETS: readonly { readonly id: "domestic" | "overseas"; readonly presetId: PresetId }[] = Object.freeze([
  { id: "domestic", presetId: "deepseek" },
  { id: "overseas", presetId: "anthropic" },
]);

// 固定值，界面上不开放调整。同时最多 6 个模型请求：长视频的分块、几个视频同时生成都更快；
// 个别服务商会因此限流，限流和过载时传输层照旧等一会儿再发。
// 单次请求超时 120 秒，长视频超时就把概览分块改成「较短」。
export const AI_CONCURRENCY = 6;
export const AI_TIMEOUT_SECONDS = 120;
// 推理档位越高，单次请求允许等得越久（初值，数值在档位映射表里）；关和低档就是上面那个值。保活的上限跟着算。
export const EFFORT_TIMEOUT_SECONDS: Readonly<Record<Effort, number>> = Object.freeze({
  off: EFFORT_BUDGETS.off.timeoutSec,
  low: EFFORT_BUDGETS.low.timeoutSec,
  medium: EFFORT_BUDGETS.medium.timeoutSec,
  high: EFFORT_BUDGETS.high.timeoutSec,
});

const MAX_MODEL_CHARS = 200;

/** 打开就出结论的时长门槛，按分钟：默认 10 分钟，可调到 0（所有视频）到 180。 */
export const AUTO_OVERVIEW_MINUTES = Object.freeze({ default: 10, min: 0, max: 180 } as const);

export const UI_FONT_SCALES = Object.freeze([100, 112, 125] as const);
export type UiFontScale = (typeof UI_FONT_SCALES)[number];

export const ANALYSIS_CHUNK_MODES = Object.freeze({
  auto: Object.freeze({ maxChars: ANALYSIS_CHUNK_CHARS, singleChars: ANALYSIS_SINGLE_CHARS }),
  short: Object.freeze({ maxChars: 3500, singleChars: 3500 }),
  long: Object.freeze({ maxChars: 12000, singleChars: 14000 }),
  // 尽量整份：六七小时以内的中文字幕一块送完，给上下文长的模型用；更长的才切成几块。
  whole: Object.freeze({ maxChars: 60_000, singleChars: 80_000 }),
});
export type AnalysisChunkMode = keyof typeof ANALYSIS_CHUNK_MODES;

interface ThemeColors {
  readonly bg: string;
  readonly card: string;
  readonly text: string;
  readonly accent: string;
}

// 主题的名字和一句话说明在设置页的文案表里，按 id 取。
interface AccentThemeInfo {
  /** 浅色的强调色填充，播放页上的按钮落在平台的浅色页面上，从这取值。 */
  readonly swatch: string;
  /** 设置页主题卡片上的小预览，明暗各一组。 */
  readonly preview: { readonly light: ThemeColors; readonly dark: ThemeColors };
}

// 三套完整配色共用同一套排版。完整色值在主题样式表里，按 html 的 data 属性切换，这里只留脚本要用的颜色，两边要一致。
export const ACCENT_THEMES = Object.freeze({
  ink: {
    swatch: "#2a6664",
    preview: {
      light: { bg: "#f6f3ed", card: "#fdfbf8", text: "#1d2428", accent: "#2a6664" },
      dark: { bg: "#141818", card: "#1b201f", text: "#e3dfd7", accent: "#76b9b6" },
    },
  },
  graphite: {
    swatch: "#515d9f",
    preview: {
      light: { bg: "#f2f4f8", card: "#ffffff", text: "#1f232b", accent: "#515d9f" },
      dark: { bg: "#15171c", card: "#1c1f23", text: "#dde0e5", accent: "#9daae4" },
    },
  },
  ochre: {
    swatch: "#8e5729",
    preview: {
      light: { bg: "#f8f3ee", card: "#fdfbf9", text: "#29211d", accent: "#8e5729" },
      dark: { bg: "#1a1614", card: "#221e1b", text: "#e5ded7", accent: "#dea77e" },
    },
  },
} as const satisfies Readonly<Record<string, AccentThemeInfo>>);
export type AccentTheme = keyof typeof ACCENT_THEMES;

export const THEME_MODES = Object.freeze({ SYSTEM: "system", LIGHT: "light", DARK: "dark" } as const);
export type ThemeMode = (typeof THEME_MODES)[keyof typeof THEME_MODES];

// 按功能选模型：同一个服务商、同一把密钥下，单项功能可以换一个模型，留空就用默认模型。请求时按 id 取，见 modelForFeature。
// 画面分析那一项只在构建开关打开时有，见 frame-slot.ts。各项的显示名在设置页的文案表里，按 id 取。
export const FEATURE_MODEL_SLOTS = Object.freeze([
  { id: "analysis" },
  { id: "verdict" },
  { id: "rewrite" },
  { id: "tidy" },
  { id: "qa" },
  { id: "notes" },
  { id: "explain" },
  ...(FEATURE_FRAME_EXPLAIN ? [FRAME_SLOT] : []),
] as const);
export type FeatureSlotId = (typeof FEATURE_MODEL_SLOTS)[number]["id"];

/** 每项功能用户选的推理强度。和按功能选的模型不同，换服务商或地址时保留，按新的服务重新解析实际档位；读的地方一律经 effortForFeature。 */
export type FeatureEfforts = Readonly<Record<FeatureSlotId, Effort>>;

export { EFFORTS };

/** 来自存储或表单，形状不可信，规整时逐项核对。 */
export interface SettingsInput {
  readonly presetId?: unknown;
  readonly protocol?: unknown;
  readonly aiApiKey?: unknown;
  readonly aiApiKeyOrigin?: unknown;
  readonly aiBaseUrl?: unknown;
  readonly aiModel?: unknown;
  readonly featureModels?: unknown;
  readonly featureModelsOwner?: unknown;
  readonly featureEfforts?: unknown;
  readonly analysisChunkMode?: unknown;
  readonly uiFontScale?: unknown;
  readonly accentTheme?: unknown;
  readonly themeMode?: unknown;
  readonly language?: unknown;
  readonly inPageCard?: unknown;
  readonly autoOverview?: unknown;
  readonly autoOverviewMinutes?: unknown;
  readonly rememberApiKey?: unknown;
  readonly dataConsentVersion?: unknown;
  readonly dataConsentFingerprint?: unknown;
  readonly activationVersion?: unknown;
  readonly activationFingerprint?: unknown;
}

export interface NormalizedSettings extends AiSettings {
  readonly presetId: PresetId;
  /** 密钥所属的 API 来源，见 bindApiKey。 */
  readonly aiApiKeyOrigin: string;
  readonly featureModels: Readonly<Partial<Record<FeatureSlotId, string>>>;
  /** 上面这组模型属于哪个服务商和地址，见 bindFeatureModels。 */
  readonly featureModelsOwner: string;
  /** 新安装全是关。 */
  readonly featureEfforts: FeatureEfforts;
  readonly analysisChunkMode: AnalysisChunkMode;
  readonly uiFontScale: UiFontScale;
  readonly accentTheme: AccentTheme;
  readonly themeMode: ThemeMode;
  /** 模型写的内容用的语言，auto 跟随浏览器的界面语言（core/output-lang.ts）；旧设置没有这一项、认不出的值都按 auto。 */
  readonly language: LanguageSetting;
  /** 播放页右栏的总结卡片。 */
  readonly inPageCard: boolean;
  /** 打开就出结论：新安装默认关。 */
  readonly autoOverview: boolean;
  /** 超过这么多分钟的视频才自动生成。 */
  readonly autoOverviewMinutes: number;
  /** 「在这台电脑上记住密钥」。默认关，打开只走设置页的保存，见 settings-store。 */
  readonly rememberApiKey: boolean;
  /** 用户确认过的数据说明版本和指纹，0 和空串是还没确认。 */
  readonly dataConsentVersion: number;
  readonly dataConsentFingerprint: string;
  /** 用户确认过的启用说明版本和指纹，0 和空串是还没确认。 */
  readonly activationVersion: number;
  readonly activationFingerprint: string;
}

export const DEFAULTS: NormalizedSettings = Object.freeze({
  presetId: DEFAULT_PRESET.id,
  protocol: DEFAULT_PRESET.protocol,
  aiApiKey: "",
  aiApiKeyOrigin: "",
  aiBaseUrl: DEFAULT_PRESET.baseUrl,
  aiModel: DEFAULT_PRESET.model,
  featureModels: Object.freeze({}),
  featureModelsOwner: "",
  featureEfforts: normalizeFeatureEfforts(undefined),
  analysisChunkMode: "auto",
  uiFontScale: UI_FONT_SCALES[0],
  accentTheme: "ink",
  themeMode: THEME_MODES.SYSTEM,
  language: "auto",
  inPageCard: true,
  autoOverview: false,
  autoOverviewMinutes: AUTO_OVERVIEW_MINUTES.default,
  rememberApiKey: false,
  dataConsentVersion: 0,
  dataConsentFingerprint: "",
  activationVersion: 0,
  activationFingerprint: "",
});

/** 用户确认当前数据说明时写进设置的字段。 */
export const DATA_CONSENT_CONFIRMED = Object.freeze({
  dataConsentVersion: DATA_CONSENT_VERSION,
  dataConsentFingerprint: DATA_CONSENT_FINGERPRINT,
});

/** 用户确认当前启用说明时写进设置的字段。 */
export const ACTIVATION_CONFIRMED = Object.freeze({
  activationVersion: ACTIVATION_VERSION,
  activationFingerprint: ACTIVATION_FINGERPRINT,
});

const isInput = (value: unknown): value is SettingsInput => typeof value === "object" && value !== null;

const isKeyOf = <Table extends object>(table: Table, value: unknown): value is keyof Table =>
  typeof value === "string" && Object.hasOwn(table, value);

const isThemeMode = (value: unknown): value is ThemeMode =>
  (Object.values(THEME_MODES) as readonly unknown[]).includes(value);

const positiveInteger = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;

const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");

export function normalizeAccentTheme(value: unknown): AccentTheme {
  return isKeyOf(ACCENT_THEMES, value) ? value : DEFAULTS.accentTheme;
}

/** 取整、限在范围里；不是数字就用默认的 10 分钟。 */
export function normalizeAutoMinutes(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return AUTO_OVERVIEW_MINUTES.default;
  return Math.min(AUTO_OVERVIEW_MINUTES.max, Math.max(AUTO_OVERVIEW_MINUTES.min, Math.round(number)));
}

/** 归到最近的一档，正好在两档中间时取大的那档；不是数字就用标准档。 */
export function normalizeUiFontScale(value: unknown): UiFontScale {
  // 空值不能交给 Number()：它把 null 和空串都算作 0。
  const number = value === null || value === "" ? Number.NaN : Number(value);
  if (!Number.isFinite(number)) return DEFAULTS.uiFontScale;
  return UI_FONT_SCALES.reduce((best, scale) => (Math.abs(scale - number) <= Math.abs(best - number) ? scale : best));
}

/** 申请主机权限时用的来源，地址不合法时为 null。 */
export function originOf(baseUrl: unknown): string | null {
  const result = validateBaseUrl(baseUrl);
  return result.ok ? result.origin : null;
}

// 密钥只属于填写它时的 API 来源。换了服务商、或自定义地址换了域名，旧密钥一律当作没填：
// 否则 A 家的密钥会随请求发给 B 家。预设厂商日后换域名也算换来源，要重新填一次。
// 刚填的密钥没有来源，归到当前地址；地址本身不合法时发不出任何请求，密钥原样保留，让校验去报地址的错。
function bindApiKey(source: SettingsInput, checked: BaseUrlCheck): { key: string; origin: string } {
  const key = stringOrEmpty(source.aiApiKey).trim();
  const recorded = stringOrEmpty(source.aiApiKeyOrigin);
  if (!key) return { key: "", origin: "" };
  if (!checked.ok) return { key, origin: recorded };
  if (!recorded || originOf(recorded) === checked.origin) return { key, origin: checked.origin };
  return { key: "", origin: "" };
}

type FeatureModels = Partial<Record<FeatureSlotId, string>>;

/** 只认已知功能下的非空字符串，长度上限和默认模型一样。 */
export function normalizeFeatureModels(input: unknown): FeatureModels {
  const out: FeatureModels = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  // 展开只取自身的键，原型链上的值不算。
  const table: Readonly<Record<string, unknown>> = { ...input };
  for (const { id } of FEATURE_MODEL_SLOTS) {
    const value = stringOrEmpty(table[id]).trim();
    if (value) out[id] = value.slice(0, MAX_MODEL_CHARS);
  }
  return out;
}

/** 六项功能都有一档：认不出的功能不写出来，认不出的档位按关。 */
export function normalizeFeatureEfforts(input: unknown): FeatureEfforts {
  const table: Readonly<Record<string, unknown>> = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const out = {} as Record<FeatureSlotId, Effort>;
  for (const { id } of FEATURE_MODEL_SLOTS) {
    const value = table[id];
    out[id] = isEffort(value) ? value : "off";
  }
  return Object.freeze(out);
}

function featureModelsOwner(presetId: string, checked: BaseUrlCheck): string {
  return checked.ok ? `${presetId}|${checked.origin}` : "";
}

// 模型名在各家之间不通用，按功能选的模型只属于填写时的服务商和地址：换了服务商预设，
// 或自定义地址换了域名，一律清空，回到默认模型。规则同 bindApiKey：没记归属的算作属于当前服务商，
// 地址不合法时原样保留。
function bindFeatureModels(
  source: SettingsInput,
  presetId: string,
  checked: BaseUrlCheck,
): { models: FeatureModels; owner: string } {
  const models = normalizeFeatureModels(source.featureModels);
  if (!Object.keys(models).length) return { models, owner: "" };
  const recorded = stringOrEmpty(source.featureModelsOwner);
  if (!checked.ok) return { models, owner: recorded };
  const owner = featureModelsOwner(presetId, checked);
  if (!recorded || recorded === owner) return { models, owner };
  return { models: {}, owner: "" };
}

/** 只写出认识的键：删掉的设置项下次保存时就从存储里消失。 */
export function normalize(input: unknown = {}): NormalizedSettings {
  const source: SettingsInput = isInput(input) ? input : {};
  const preset = presetById(source.presetId) ?? DEFAULT_PRESET;
  const { protocol, aiBaseUrl } = resolveEndpoint(source);
  const model = stringOrEmpty(source.aiModel).trim() || preset.model;
  const checked = validateBaseUrl(aiBaseUrl, protocol);
  const apiKey = bindApiKey(source, checked);
  const featureModels = bindFeatureModels(source, preset.id, checked);
  return {
    presetId: preset.id,
    protocol,
    aiApiKey: apiKey.key,
    aiApiKeyOrigin: apiKey.origin,
    aiBaseUrl,
    aiModel: model.slice(0, MAX_MODEL_CHARS),
    featureModels: featureModels.models,
    featureModelsOwner: featureModels.owner,
    featureEfforts: normalizeFeatureEfforts(source.featureEfforts),
    analysisChunkMode: isKeyOf(ANALYSIS_CHUNK_MODES, source.analysisChunkMode)
      ? source.analysisChunkMode
      : DEFAULTS.analysisChunkMode,
    uiFontScale: normalizeUiFontScale(source.uiFontScale),
    accentTheme: normalizeAccentTheme(source.accentTheme),
    themeMode: isThemeMode(source.themeMode) ? source.themeMode : DEFAULTS.themeMode,
    language: isLanguageSetting(source.language) ? source.language : DEFAULTS.language,
    // 只认真正的布尔值：没有这一项、或被写成了别的类型时按默认开启。
    inPageCard: typeof source.inPageCard === "boolean" ? source.inPageCard : DEFAULTS.inPageCard,
    // 花额度的开关只认 true：没有这一项、或写成别的值，都按关着。
    autoOverview: source.autoOverview === true,
    autoOverviewMinutes: normalizeAutoMinutes(source.autoOverviewMinutes),
    // 只认 true：没有这一项、或写成别的值，都按没选记住。
    rememberApiKey: source.rememberApiKey === true,
    // 同意和启用的版本、指纹只核对形状就存下：对不对得上当前说明由校验和 activationStatus 判断，
    // 认得出确认过哪一版，才能只列之后新增的内容。
    dataConsentVersion: positiveInteger(source.dataConsentVersion),
    dataConsentFingerprint: stringOrEmpty(source.dataConsentFingerprint),
    activationVersion: positiveInteger(source.activationVersion),
    activationFingerprint: stringOrEmpty(source.activationFingerprint),
  };
}

/** 设置页用：表单当前的服务商和地址对应的归属，地址不合法时为空串。 */
export function featureModelsOwnerOf(settings: unknown): string {
  const normalized = normalize(settings);
  return featureModelsOwner(normalized.presetId, validateBaseUrl(normalized.aiBaseUrl, normalized.protocol));
}

/** 某项功能实际要用的模型：设置了就用它，没设置或功能名认不出时用默认模型。 */
export function modelForFeature(settings: unknown, feature: string | undefined): string {
  const normalized = normalize(settings);
  return (isKeyOf(normalized.featureModels, feature) ? normalized.featureModels[feature] : "") || normalized.aiModel;
}

/** 某项功能用户选的推理强度：功能名认不出时按关。实际生效的档位还要看服务和模型，见 core/ai/provider/effort.ts。 */
export function effortForFeature(settings: unknown, feature: string | undefined): Effort {
  const { featureEfforts } = normalize(settings);
  return isKeyOf(featureEfforts, feature) ? featureEfforts[feature] : "off";
}

/** 把 aiModel 换成这项功能实际要用的模型。请求构造、能力查询和放宽记忆都按 aiModel 区分，换掉这一项就全部跟着走。 */
export function withFeatureModel<T extends AiSettings>(settings: T, feature: string | undefined): T {
  const model = modelForFeature(settings, feature);
  return model === settings.aiModel ? settings : { ...settings, aiModel: model };
}

export interface AnalysisChunkOptions {
  readonly maxChars: number;
  readonly singleChars: number;
  /** 选的是「尽量整份」：超时或被嫌太长时，报错里提示换回别的档。 */
  readonly whole?: true;
}

/** 概览分块的字符上限。分块重叠用 core/ai/chunking.ts 的默认值。 */
export function analysisChunkOptions(settings: unknown = {}): AnalysisChunkOptions {
  const mode = normalize(settings).analysisChunkMode;
  return { ...ANALYSIS_CHUNK_MODES[mode], ...(mode === "whole" ? { whole: true as const } : {}) };
}

/**
 * 问答检索用的分块：跟着概览的设置，只有「尽量整份」时按自动切。
 * 问答按块挑相关的字幕，块太大就挑不出来，模型装不下时也缩不小。
 */
export function qaChunkOptions(settings: unknown = {}): AnalysisChunkOptions {
  const options = analysisChunkOptions(settings);
  return options.whole ? { ...ANALYSIS_CHUNK_MODES.auto } : options;
}

export interface SettingsCheck {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly settings: NormalizedSettings;
}

/** 配置能不能保存。保存要按地址申请主机权限，所以地址必须合法；密钥和模型可以先空着，清空密钥再保存就是删除密钥。errors 按 lang 写，不传时是中文。 */
export function validateForSave(settings: unknown, lang: OutputLang = "zh"): SettingsCheck {
  const normalized = normalize(settings);
  const base = validateBaseUrl(normalized.aiBaseUrl, normalized.protocol, lang);
  return { ok: base.ok, errors: base.ok ? [] : [base.error], settings: normalized };
}

/**
 * 配置是否足以发起一次 AI 请求。设置页和后台共用同一套判断。本机地址的服务通常不要密钥，可以不填。
 * errors 按 lang 写，不传时是中文；后台按中文的 DATA_CONSENT_ERROR 认出是同意的问题，要认的地方别传语言。
 */
export function validate(settings: unknown, lang: OutputLang = "zh"): SettingsCheck {
  const normalized = normalize(settings);
  const say = settingsCheckText(lang);
  const errors: string[] = [];
  if (!normalized.aiApiKey && !isLocalBaseUrl(normalized.aiBaseUrl)) errors.push(say.missingKey);
  if (!dataConsentGiven(normalized, DATA_CONSENT_CONFIRMED)) errors.push(dataConsentErrorText(lang));
  const base = validateBaseUrl(normalized.aiBaseUrl, normalized.protocol, lang);
  if (!base.ok) errors.push(base.error);
  if (!normalized.aiModel) errors.push(say.missingModel);
  return { ok: errors.length === 0, errors, settings: normalized };
}

/** 启用确认还算不算数：版本或指纹和当前不一致就按未确认处理。开发者本人的日用包里确认过的照旧算数（core/consent-carry.ts）。 */
export function activationStatus(settings: unknown): NoticeStatus<ActivationKind> {
  const stored = normalize(settings);
  return FEATURE_KEEP_CONSENT ? carryActivation(stored) : noticeStatus(ACTIVATION_TABLE, { version: stored.activationVersion, fingerprint: stored.activationFingerprint });
}

/** 传输层用的规则，后台建传输层时传这一份。 */
export const settingsRules: TransportSettingsRules = {
  validate,
  normalize,
  withFeatureModel,
  ...DATA_CONSENT_CONFIRMED,
  dataConsentError: DATA_CONSENT_ERROR,
  timeoutSeconds: AI_TIMEOUT_SECONDS,
};
