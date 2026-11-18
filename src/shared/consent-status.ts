// 数据说明的同意状态，设置页和工具栏图标的右键菜单共用。开发者本人的日用包里同意过的照旧算数（core/consent-carry.ts），对外的发行包按版本和指纹核对。
import { carryConsent } from "../core/consent-carry.ts";
import { DATA_CONSENT_TABLE, noticeStatus, type DataConsentKind, type NoticeStatus } from "../core/consent.ts";
import type { NormalizedSettings } from "./settings-schema.ts";

export function dataConsentStatus(saved: Pick<NormalizedSettings, "dataConsentVersion" | "dataConsentFingerprint">): NoticeStatus<DataConsentKind> {
  const stored = { version: saved.dataConsentVersion, fingerprint: saved.dataConsentFingerprint };
  return FEATURE_KEEP_CONSENT ? carryConsent(DATA_CONSENT_TABLE, stored) : noticeStatus(DATA_CONSENT_TABLE, stored);
}
