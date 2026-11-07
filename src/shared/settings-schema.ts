// 设置的结构和规则：默认值、规整、校验、按功能选模型。读写存储在设置仓库里，这里不碰 chrome.*。
// 协议和地址只写在 core/ai/provider/endpoint.ts，这里按 id 补给界面用的内容，依赖方向是这里导入那边。
import { ANALYSIS_CHUNK_CHARS, ANALYSIS_SINGLE_CHARS } from "../core/ai/chunking.ts";
import {
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET as DEFAULT_ENDPOINT,
  ENDPOINT_PRESETS,
  resolveEndpoint,
  validateBaseUrl,
  type BaseUrlCheck,
  type KnownEndpointPreset,
  type PresetId,
} from "../core/ai/provider/endpoint.ts";
import type { AiSettings } from "../core/ai/provider/index.ts";
import type { TransportSettingsRules } from "../core/ai/transport/index.ts";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_TABLE,
  ACTIVATION_VERSION,
  DATA_CONSENT_ERROR,
  DATA_CONSENT_FINGERPRINT,
  DATA_CONSENT_VERSION,
  dataConsentGiven,
  noticeStatus,
  type ActivationKind,
  type NoticeStatus,
} from "../core/consent.ts";

export { CUSTOM_PRESET_ID };

interface PresetDetail {
  readonly label: string;
  /** 只给默认的 Anthropic 和 DeepSeek 预置，其余留空，用户在模型列表里自己选。 */
  readonly model: string;
  /** 密钥页。 */
  readonly docsUrl: string;
}

export type ServicePreset = KnownEndpointPreset & PresetDetail;

const PRESET_DETAILS: Readonly<Record<PresetId, PresetDetail>> = {
  // 默认用 Sonnet：概览按块调用、批量生成会累积，Opus 留给用户自己选。
  anthropic: {
    label: "Anthropic Claude",
    model: "claude-sonnet-5-5",
    docsUrl: "https://platform.claude.com/settings/keys",
  },
  openai: { label: "OpenAI", model: "", docsUrl: "https://platform.openai.com/api-keys" },
  deepseek: { label: "DeepSeek", model: "deepseek-v4-flash", docsUrl: "https://platform.deepseek.com/api_keys" },
  gemini: { label: "Google Gemini（OpenAI 兼容端点）", model: "", docsUrl: "https://aistudio.google.com/apikey" },
  moonshot: { label: "月之暗面 Kimi", model: "", docsUrl: "https://platform.kimi.com/console/api-keys" },
  zhipu: { label: "智谱 GLM", model: "", docsUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys" },
  // 密钥页指向北京地域，和预设的地址一致。
  dashscope: {
    label: "阿里云百炼（通义千问）",
    model: "",
    docsUrl: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
  },
  siliconflow: { label: "硅基流动 SiliconFlow", model: "", docsUrl: "https://cloud.siliconflow.cn/account/ak" },
  openrouter: { label: "OpenRouter", model: "", docsUrl: "https://openrouter.ai/keys" },
  [CUSTOM_PRESET_ID]: { label: "自定义", model: "", docsUrl: "" },
};

const withDetail = (preset: KnownEndpointPreset): ServicePreset => ({ ...preset, ...PRESET_DETAILS[preset.id] });

export const PRESETS: readonly ServicePreset[] = Object.freeze(ENDPOINT_PRESETS.map(withDetail));

const DEFAULT_PRESET = withDetail(DEFAULT_ENDPOINT);

export const presetById = (id: unknown): ServicePreset | null => PRESETS.find((preset) => preset.id === id) ?? null;

// 设置页还没填密钥时给的快捷选择，国内在前。只帮着选预设，不判断用户所在地，
// 也不保证账户能开通：Anthropic 不对中国大陆、香港、澳门开放。
export const REGION_PRESETS: readonly { readonly id: string; readonly label: string; readonly presetId: PresetId }[] =
  Object.freeze([
    { id: "domestic", label: "国内服务", presetId: "deepseek" },
    { id: "overseas", label: "海外服务", presetId: "anthropic" },
  ]);

// 固定值，界面上不开放调整。并发 3 是多数服务商限流以内的稳妥值，几个视频同时生成时共用；
// 单次请求超时 120 秒，长视频超时就把概览分块改成「较短」。
export const AI_CONCURRENCY = 3;
export const AI_TIMEOUT_SECONDS = 120;

const MAX_MODEL_CHARS = 200;

export const UI_FONT_SCALES = Object.freeze([100, 112, 125] as const);
export type UiFontScale = (typeof UI_FONT_SCALES)[number];

export const ANALYSIS_CHUNK_MODES = Object.freeze({
  auto: Object.freeze({ maxChars: ANALYSIS_CHUNK_CHARS, singleChars: ANALYSIS_SINGLE_CHARS }),
  short: Object.freeze({ maxChars: 3500, singleChars: 3500 }),
  long: Object.freeze({ maxChars: 12000, singleChars: 14000 }),
});
export type AnalysisChunkMode = keyof typeof ANALYSIS_CHUNK_MODES;

interface ThemeColors {
  readonly bg: string;
  readonly card: string;
  readonly text: string;
  readonly accent: string;
}

interface AccentThemeInfo {
  readonly label: string;
  readonly note: string;
  /** 浅色的强调色填充，播放页上的按钮落在平台的浅色页面上，从这取值。 */
  readonly swatch: string;
  /** 设置页主题卡片上的小预览，明暗各一组。 */
  readonly preview: { readonly light: ThemeColors; readonly dark: ThemeColors };
}

// 三套完整配色共用同一套排版。完整色值在主题样式表里，按 html 的 data 属性切换，这里只留脚本要用的颜色，两边要一致。
export const ACCENT_THEMES = Object.freeze({
  ink: {
    label: "宣纸墨青",
    note: "暖白纸面，青黛点缀",
    swatch: "#2a6664",
    preview: {
      light: { bg: "#f6f3ed", card: "#fdfbf8", text: "#1d2428", accent: "#2a6664" },
      dark: { bg: "#141818", card: "#1b201f", text: "#e3dfd7", accent: "#76b9b6" },
    },
  },
  graphite: {
    label: "石墨靛蓝",
    note: "冷调石墨灰，靛蓝点缀",
    swatch: "#515d9f",
    preview: {
      light: { bg: "#f2f4f8", card: "#ffffff", text: "#1f232b", accent: "#515d9f" },
      dark: { bg: "#15171c", card: "#1c1f23", text: "#dde0e5", accent: "#9daae4" },
    },
  },
  ochre: {
    label: "暖岩赭石",
    note: "暖灰岩色，赭石点缀",
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
export const FEATURE_MODEL_SLOTS = Object.freeze([
  { id: "analysis", label: "概览" },
  { id: "verdict", label: "一句话结论" },
  { id: "rewrite", label: "翻译" },
  { id: "qa", label: "问答" },
  { id: "notes", label: "笔记润色" },
  { id: "explain", label: "划词解释" },
] as const);
export type FeatureSlotId = (typeof FEATURE_MODEL_SLOTS)[number]["id"];

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
  readonly analysisChunkMode?: unknown;
  readonly uiFontScale?: unknown;
  readonly accentTheme?: unknown;
  readonly themeMode?: unknown;
  readonly inPageCard?: unknown;
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
  readonly analysisChunkMode: AnalysisChunkMode;
  readonly uiFontScale: UiFontScale;
  readonly accentTheme: AccentTheme;
  readonly themeMode: ThemeMode;
  /** 播放页右栏的总结卡片。 */
  readonly inPageCard: boolean;
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
  analysisChunkMode: "auto",
  uiFontScale: UI_FONT_SCALES[0],
  accentTheme: "ink",
  themeMode: THEME_MODES.SYSTEM,
  inPageCard: true,
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
    analysisChunkMode: isKeyOf(ANALYSIS_CHUNK_MODES, source.analysisChunkMode)
      ? source.analysisChunkMode
      : DEFAULTS.analysisChunkMode,
    uiFontScale: normalizeUiFontScale(source.uiFontScale),
    accentTheme: normalizeAccentTheme(source.accentTheme),
    themeMode: isThemeMode(source.themeMode) ? source.themeMode : DEFAULTS.themeMode,
    // 只认真正的布尔值：没有这一项、或被写成了别的类型时按默认开启。
    inPageCard: typeof source.inPageCard === "boolean" ? source.inPageCard : DEFAULTS.inPageCard,
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

/** 把 aiModel 换成这项功能实际要用的模型。请求构造、能力查询和放宽记忆都按 aiModel 区分，换掉这一项就全部跟着走。 */
export function withFeatureModel<T extends AiSettings>(settings: T, feature: string | undefined): T {
  const model = modelForFeature(settings, feature);
  return model === settings.aiModel ? settings : { ...settings, aiModel: model };
}

/** 概览分块的字符上限。分块重叠用 core/ai/chunking.ts 的默认值。 */
export function analysisChunkOptions(settings: unknown = {}): { maxChars: number; singleChars: number } {
  return { ...ANALYSIS_CHUNK_MODES[normalize(settings).analysisChunkMode] };
}

export interface SettingsCheck {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly settings: NormalizedSettings;
}

/** 配置能不能保存。保存要按地址申请主机权限，所以地址必须合法；密钥和模型可以先空着，清空密钥再保存就是删除密钥。 */
export function validateForSave(settings: unknown): SettingsCheck {
  const normalized = normalize(settings);
  const base = validateBaseUrl(normalized.aiBaseUrl, normalized.protocol);
  return { ok: base.ok, errors: base.ok ? [] : [base.error], settings: normalized };
}

/** 配置是否足以发起一次 AI 请求。设置页和后台共用同一套判断。 */
export function validate(settings: unknown): SettingsCheck {
  const normalized = normalize(settings);
  const errors: string[] = [];
  if (!normalized.aiApiKey) errors.push("请填写 API 密钥（没选记住密钥时，浏览器重启、扩展更新后要重新填）。");
  if (!dataConsentGiven(normalized, DATA_CONSENT_CONFIRMED)) errors.push(DATA_CONSENT_ERROR);
  const base = validateBaseUrl(normalized.aiBaseUrl, normalized.protocol);
  if (!base.ok) errors.push(base.error);
  if (!normalized.aiModel) errors.push("请填写模型名称，或点击「拉取模型列表」进行选择。");
  return { ok: errors.length === 0, errors, settings: normalized };
}

/** 启用确认还算不算数：版本或指纹和当前不一致就按未确认处理，不算时给出这次要显示的说明。 */
export function activationStatus(settings: unknown): NoticeStatus<ActivationKind> {
  const { activationVersion, activationFingerprint } = normalize(settings);
  return noticeStatus(ACTIVATION_TABLE, { version: activationVersion, fingerprint: activationFingerprint });
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
