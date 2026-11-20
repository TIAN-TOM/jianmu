/// <reference types="chrome" />
// 浏览器的界面语言。读不到时回空串，解析时按英文算。

export function browserUiLanguage(): string {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return typeof navigator === "undefined" ? "" : navigator.language;
  }
}
