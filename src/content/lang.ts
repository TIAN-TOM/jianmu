/// <reference types="chrome" />
// 播放页上的界面语言。内容脚本读不到扩展页面的首帧缓存，也读不到存储：语言选项和卡片开关走同一条路，
// 跟着外观从后台拿（问一次外观、外观变了的广播），再配上浏览器的界面语言，按 core/output-lang.ts 解析成中文或英文。
// 后台的回复里还没有语言选项、或者取值认不出时，按跟随浏览器算。
import { isLanguageSetting, resolveOutputLang, type LanguageSetting, type OutputLang } from "../core/output-lang.ts";

export interface ContentLang {
  /** 现在的界面语言。 */
  readonly current: () => OutputLang;
  /** 按外观里带的语言选项重算；语言变了回 true。 */
  readonly update: (view: unknown) => boolean;
}

/** 外观回复或广播里带的语言选项；没带或认不出时是跟随浏览器。 */
export function languageSettingOf(view: unknown): LanguageSetting {
  const language = typeof view === "object" && view !== null ? (view as { readonly language?: unknown }).language : undefined;
  return isLanguageSetting(language) ? language : "auto";
}

/** 浏览器的界面语言；读不到时回空串，解析时按英文算。内容脚本包里不带 platform 的模块，这里自己读。 */
export function pageUiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return typeof navigator === "undefined" ? "" : navigator.language;
  }
}

/** 外观到之前按跟随浏览器算。 */
export function createContentLang(uiLanguage: () => string): ContentLang {
  let lang = resolveOutputLang("auto", uiLanguage());
  return {
    current: () => lang,
    update(view) {
      const next = resolveOutputLang(languageSettingOf(view), uiLanguage());
      if (next === lang) return false;
      lang = next;
      return true;
    },
  };
}
