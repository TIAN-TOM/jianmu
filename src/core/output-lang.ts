// 模型写的内容和界面用哪种语言：设置里的选项加上浏览器的界面语言，解析成简体中文、繁体中文或英文。界面语言由调用方传进来，这里不碰 chrome.*。
// 按语言挑文字一律经 inLang：简体那份定形状，繁体那份放在文件名以 -hant.ts 结尾的模块里，三份都必给。

/** 实际用的语言：zh 是简体中文，zh-Hant 是繁体中文。 */
export type OutputLang = "zh" | "zh-Hant" | "en";

export const OUTPUT_LANGS = Object.freeze(["zh", "zh-Hant", "en"] as const);

/** 设置里的语言选项：auto 跟随浏览器的界面语言，zh 是简体中文。 */
export const LANGUAGE_SETTINGS = Object.freeze(["auto", "zh", "zh-Hant", "en"] as const);
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

export const isLanguageSetting = (value: unknown): value is LanguageSetting =>
  (LANGUAGE_SETTINGS as readonly unknown[]).includes(value);

// 浏览器界面语言里算繁体的写法：带 Hant 的，和台湾、香港、澳门三个地区。
const HANT_UI = /^zh[-_](?:hant(?:[-_]|$)|(?:tw|hk|mo)(?:[-_]|$))/i;
const ZH_UI = /^zh(?:[-_]|$)/i;

/** 选了哪种就用哪种；跟随浏览器时，界面语言是繁体的写法算繁体，其余以 zh 开头的算简体，别的算英文。 */
export function resolveOutputLang(setting: LanguageSetting, uiLanguage: string): OutputLang {
  if (setting !== "auto") return setting;
  const ui = uiLanguage.trim();
  if (HANT_UI.test(ui)) return "zh-Hant";
  return ZH_UI.test(ui) ? "zh" : "en";
}

export const isOutputLang = (value: unknown): value is OutputLang => (OUTPUT_LANGS as readonly unknown[]).includes(value);

/** 结果或任务记下的语言：旧记录、旧任务没有这一项，一律当简体。 */
export function outputLangOf(gen: { readonly outputLang?: OutputLang | undefined } | null | undefined): OutputLang {
  const lang: unknown = gen?.outputLang;
  return isOutputLang(lang) ? lang : "zh";
}

/** 简体或繁体：中文的排版、拼句和判断字幕语言时两者走同一条路。 */
export const isChineseLang = (lang: OutputLang): boolean => lang !== "en";

/**
 * 按语言挑一份：简体、英文、繁体三份都必给。
 * 繁体那份取自同名的 -hant.ts 模块，例如 inLang(lang, TEXT_ZH, TEXT_EN, TEXT_HANT)。
 */
export function inLang<T>(lang: OutputLang, zh: T, en: T, hant: T): T {
  if (lang === "en") return en;
  return lang === "zh-Hant" ? hant : zh;
}
