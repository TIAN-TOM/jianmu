// 设置读写的错误码给用户看的三段话，繁体这份。码由简体那份（settings.ts）定，少一条、多一条，类型检查就报错。
import type { ErrorCopy } from "./copy.ts";
import type { SettingsErrorCode } from "./settings.ts";

const NOT_REMEMBERED = "金鑰沒有記在這台電腦上，這次的修改也沒有儲存。";

export const SETTINGS_ERROR_TEXT_HANT: Readonly<Record<SettingsErrorCode, ErrorCopy>> = {
  SETTINGS_STALE: { cause: "設定剛在別的頁面改過，這裡的表單過時了。", impact: "這次沒有儲存。", next: "按最新的設定再改一次。" },
  REMEMBER_KEY_UNPROTECTED: { cause: "沒能限制本機儲存空間的存取範圍。", impact: NOT_REMEMBERED, next: "先取消勾選「在這台電腦上記住金鑰」再儲存，金鑰只留在這次工作階段裡。" },
  REMEMBER_KEY_UNBOUND: { cause: "金鑰缺少所屬的 API 網址。", impact: NOT_REMEMBERED, next: "到設定頁填好 API 網址，再點選「儲存並授權」。" },
};
