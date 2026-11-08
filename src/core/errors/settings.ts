// 设置读写的错误码和给用户看的一句话。

export type SettingsErrorCode = "SETTINGS_STALE" | "REMEMBER_KEY_UNPROTECTED" | "REMEMBER_KEY_UNBOUND";

export const SETTINGS_ERROR_TEXT: Readonly<Record<SettingsErrorCode, string>> = {
  SETTINGS_STALE: "设置刚在别的页面改过，这里的表单已经过时。",
  REMEMBER_KEY_UNPROTECTED: "没能限制本机存储的访问范围，密钥没有记到这台电脑上。",
  REMEMBER_KEY_UNBOUND: "密钥缺少所属的 API 地址，没有记到这台电脑上。",
};

/** 运行时核对用的码表，跨消息或从异常里取出的码要先过它。 */
export const SETTINGS_ERROR_CODES: readonly SettingsErrorCode[] = Object.freeze(
  Object.keys(SETTINGS_ERROR_TEXT) as SettingsErrorCode[],
);
