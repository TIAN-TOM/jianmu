// 开发者本人日用包的例外（开发者本人 2026-11-19 定）：确认过、同意过的人，说明的条目变了也沿用，不拦读取、不停发送、不要求重新点，
// 只把这次多出来的条目交给侧边栏顶上那一行列出来，看过再记下当前这一版。从没确认、没同意过的照旧要走一遍；
// 清除全部数据会连确认和同意一起清掉，之后照旧要走一遍。只从 FEATURE_KEEP_CONSENT 的分支引用，对外的发行包里没有这个模块。
import {
  ACTIVATION_TABLE,
  DATA_CONSENT_TABLE,
  everAgreed,
  noticeStatus,
  versionStamps,
  type ActivationKind,
  type NoticeItem,
  type NoticeStatus,
  type NoticeTable,
  type StoredStamp,
} from "./consent.ts";

/**
 * 确认过的那一版之后多出来的条目。按指纹认确认的是哪一版，就是之后几版的：存着的版本号表里没有时，
 * 条目一样指纹就一样，照样认得出。指纹也认不出（后来条目又并进了那一版），从那个版本号起的都算，版本号比表里的都大就全列，宁可多列几条。
 */
function newer<Kind extends string>(table: NoticeTable<Kind>, stored: StoredStamp): NoticeItem<Kind>[] {
  if (noticeStatus(table, stored).state === "current") return [];
  const at = versionStamps(table).findIndex((stamp) => stamp.fingerprint === stored.fingerprint);
  if (at >= 0) return table.slice(at + 1).flatMap((row) => row.items);
  const rows = table.filter((row) => row.version >= Number(stored.version));
  return (rows.length ? rows : table).flatMap((row) => row.items);
}

/**
 * 启用说明的状态，换成沿用的：确认过的照旧算启用，这次多出来的条目放进 carried；数据说明同意过、条目变了的，多出来的也放进去。
 * 从没确认过的原样返回，照旧要走一遍。
 */
export function carryNotices<Kind extends string>(table: NoticeTable<Kind>, stored: StoredStamp, consent: { readonly table: NoticeTable<string>; readonly stored: StoredStamp }): NoticeStatus<Kind> {
  const status = noticeStatus(table, stored);
  if (status.state === "needed" && !everAgreed(stored)) return status;
  const carried = { activation: newer(table, stored), consent: everAgreed(consent.stored) ? newer(consent.table, consent.stored) : [] };
  return carried.activation.length || carried.consent.length ? { state: "current", carried } : { state: "current" };
}

/** 设置里存着的两份确认，换成沿用的启用状态。 */
export function carryActivation(settings: {
  readonly activationVersion: unknown;
  readonly activationFingerprint: unknown;
  readonly dataConsentVersion: unknown;
  readonly dataConsentFingerprint: unknown;
}): NoticeStatus<ActivationKind> {
  const consent = { table: DATA_CONSENT_TABLE, stored: { version: settings.dataConsentVersion, fingerprint: settings.dataConsentFingerprint } };
  return carryNotices(ACTIVATION_TABLE, { version: settings.activationVersion, fingerprint: settings.activationFingerprint }, consent);
}

/** 确认之前启用就已经算数（沿用着）：这次确认只是记下看过多出来的条目。 */
export function wasEnabled(status: NoticeStatus<string> | null): boolean {
  return status?.state === "current";
}

/** 数据说明的状态，换成沿用的：同意过的照旧算同意，从没同意过的原样返回。 */
export function carryConsent<Kind extends string>(table: NoticeTable<Kind>, stored: StoredStamp): NoticeStatus<Kind> {
  const status = noticeStatus(table, stored);
  if (status.state === "current" || !everAgreed(stored)) return status;
  const consent = newer(table, stored);
  return consent.length ? { state: "current", carried: { activation: [], consent } } : { state: "current" };
}
