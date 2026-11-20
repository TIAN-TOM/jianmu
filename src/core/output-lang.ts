// 模型写的内容用哪种语言：设置里的选项加上浏览器的界面语言，解析成中文或英文。界面语言由调用方传进来，这里不碰 chrome.*。

/** 模型写的内容实际用的语言。 */
export type OutputLang = "zh" | "en";

/** 设置里的语言选项：auto 跟随浏览器的界面语言。 */
export const LANGUAGE_SETTINGS = Object.freeze(["auto", "zh", "en"] as const);
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

export const isLanguageSetting = (value: unknown): value is LanguageSetting =>
  (LANGUAGE_SETTINGS as readonly unknown[]).includes(value);

/** 选了中文或英文就用它；跟随浏览器时，界面语言以 zh 开头算中文，其余算英文。 */
export function resolveOutputLang(setting: LanguageSetting, uiLanguage: string): OutputLang {
  if (setting !== "auto") return setting;
  return /^zh(?:[-_]|$)/i.test(uiLanguage.trim()) ? "zh" : "en";
}

/** 结果或任务记下的语言：旧记录、旧任务没有这一项，一律当中文。 */
export const outputLangOf = (gen: { readonly outputLang?: OutputLang | undefined } | null | undefined): OutputLang =>
  gen?.outputLang === "en" ? "en" : "zh";

export const isOutputLang = (value: unknown): value is OutputLang => value === "zh" || value === "en";
