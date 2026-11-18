// 设置页显示的数据同意状态。开发者本人的日用包里同意过的照旧算数（core/consent-carry.ts），对外的发行包按版本和指纹核对。
import { carryConsent } from "../../core/consent-carry.ts";
import { DATA_CONSENT_TABLE, noticeStatus, type DataConsentKind, type NoticeStatus } from "../../core/consent.ts";
import type { LoadedSettings } from "../../platform/settings-store.ts";

export function dataConsentStatus(saved: Pick<LoadedSettings, "dataConsentVersion" | "dataConsentFingerprint">): NoticeStatus<DataConsentKind> {
  const stored = { version: saved.dataConsentVersion, fingerprint: saved.dataConsentFingerprint };
  return FEATURE_KEEP_CONSENT ? carryConsent(DATA_CONSENT_TABLE, stored) : noticeStatus(DATA_CONSENT_TABLE, stored);
}
