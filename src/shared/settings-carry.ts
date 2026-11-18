// 开发者本人日用包的例外：侧边栏「说明更新了」看过以后，同意过的数据说明也记成当前这一版，下次不再列。
// 只从 FEATURE_KEEP_CONSENT 的分支引用，对外的发行包里没有这个模块。
import { everAgreed } from "../core/consent.ts";
import { DATA_CONSENT_CONFIRMED } from "./settings-schema.ts";

/** 同意过某一版的，换成当前这一版的版本和指纹；从没同意过的不动。 */
export function refreshedConsent(settings: { readonly dataConsentVersion?: unknown }): Partial<typeof DATA_CONSENT_CONFIRMED> {
  return everAgreed({ version: settings.dataConsentVersion }) ? DATA_CONSENT_CONFIRMED : {};
}
