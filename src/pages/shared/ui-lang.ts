/// <reference types="chrome" />
// 扩展页面的界面语言：页面级的一个 signal，值是 zh 或 en。页面启动时按首帧缓存里的语言选项和浏览器的界面语言同步定下，
// 第一帧就是对的语言；之后外观落地时（theme.ts 读回设置、设置变了）跟着设置里的语言选项纠正。
// 界面文案按界面各放一份中英两种的表，组件渲染时用 byLang 取当前语言那份，语言变了组件跟着重画。
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import { isLanguageSetting, resolveOutputLang, type LanguageSetting, type OutputLang } from "../../core/output-lang.ts";
import { browserUiLanguage } from "../../platform/ui-language.ts";
import { APPEARANCE_CACHE_KEY } from "../../shared/names.ts";

export type UiLang = OutputLang;

const current = signal<UiLang>("zh");

/** 当前的界面语言。 */
export const uiLang: ReadonlySignal<UiLang> = current;

/** <html lang> 的写法。 */
export const HTML_LANG: Readonly<Record<UiLang, string>> = Object.freeze({ zh: "zh-CN", en: "en" });

/** 首帧缓存里的语言选项：缓存由 theme.ts 落地外观时连同外观一起写。没有、损坏、读存储抛错或取值认不出时按跟随浏览器。 */
export function cachedLanguage(storage: Pick<Storage, "getItem"> | null | undefined): LanguageSetting {
  try {
    const cached: unknown = JSON.parse(storage?.getItem(APPEARANCE_CACHE_KEY) ?? "null");
    const language = typeof cached === "object" && cached !== null ? (cached as Record<string, unknown>).language : undefined;
    return isLanguageSetting(language) ? language : "auto";
  } catch {
    return "auto";
  }
}

/** 按语言选项和浏览器的界面语言定下界面语言。选项认不出时按跟随浏览器。 */
export function setUiLanguage(setting: unknown, uiLanguage: string = browserUiLanguage()): UiLang {
  const lang = resolveOutputLang(isLanguageSetting(setting) ? setting : "auto", uiLanguage);
  current.value = lang;
  return lang;
}

// 存储被禁用时连读 localStorage 这个属性都会抛错。
function pageStorage(): Pick<Storage, "getItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 页面入口在渲染之前同步调用：按首帧缓存定下语言，读回设置以后由 theme.ts 纠正。 */
export function initUiLang(storage: Pick<Storage, "getItem"> | null | undefined = pageStorage(), uiLanguage: string = browserUiLanguage()): UiLang {
  return setUiLanguage(cachedLanguage(storage), uiLanguage);
}

export interface LangDocument {
  readonly documentElement: { lang: string };
  title: string;
}

/** 跟着界面语言写 <html lang> 和页面标题。回停止跟随的函数。 */
export function bindDocumentLang(doc: LangDocument, titleOf: (lang: UiLang) => string): () => void {
  return effect(() => {
    const lang = current.value;
    doc.documentElement.lang = HTML_LANG[lang];
    doc.title = titleOf(lang);
  });
}

/** 按给定的语言取两份表里的一份。纯逻辑用这个，语言由调用方传进来。 */
export const inLang = <T>(lang: UiLang, zh: T, en: T): T => (lang === "en" ? en : zh);

/** 取当前界面语言那份表。在组件渲染时调用，组件就跟着语言重画。 */
export const byLang = <T>(zh: T, en: T): T => inLang(current.value, zh, en);
