// 设置读写的错误码和给用户看的三段话。
import type { ErrorCopy } from "./copy.ts";

export type SettingsErrorCode = "SETTINGS_STALE" | "REMEMBER_KEY_UNPROTECTED" | "REMEMBER_KEY_UNBOUND";

const NOT_REMEMBERED = "密钥没有记到这台电脑上，这次的修改也没有保存。";

export const SETTINGS_ERROR_TEXT: Readonly<Record<SettingsErrorCode, ErrorCopy>> = {
  SETTINGS_STALE: { cause: "设置刚在别的页面改过，这里的表单过时了。", impact: "这次没有保存。", next: "按最新的设置再改一次。" },
  REMEMBER_KEY_UNPROTECTED: { cause: "没能限制本机存储的访问范围。", impact: NOT_REMEMBERED, next: "先取消勾选「在这台电脑上记住密钥」再保存，密钥只留在这次会话里。" },
  REMEMBER_KEY_UNBOUND: { cause: "密钥缺少所属的 API 地址。", impact: NOT_REMEMBERED, next: "到设置页填好 API 地址，再点「保存」。" },
};

const NOT_REMEMBERED_EN = "The key wasn't remembered on this computer, and your changes weren't saved.";

export const SETTINGS_ERROR_TEXT_EN: Readonly<Record<SettingsErrorCode, ErrorCopy>> = {
  SETTINGS_STALE: { cause: "Settings were just changed on another page, so this form is out of date.", impact: "Nothing was saved.", next: "Make your changes again on the latest settings." },
  REMEMBER_KEY_UNPROTECTED: { cause: "Jianmu couldn't restrict who can read its local storage.", impact: NOT_REMEMBERED_EN, next: "Untick “Remember the key on this computer” and save again. The key then stays only for this browser session." },
  REMEMBER_KEY_UNBOUND: { cause: "The key has no API address to go with it.", impact: NOT_REMEMBERED_EN, next: "Fill in the API address in settings, then click “Save”." },
};

/** 运行时核对用的码表，跨消息或从异常里取出的码要先过它。 */
export const SETTINGS_ERROR_CODES: readonly SettingsErrorCode[] = Object.freeze(
  Object.keys(SETTINGS_ERROR_TEXT) as SettingsErrorCode[],
);
