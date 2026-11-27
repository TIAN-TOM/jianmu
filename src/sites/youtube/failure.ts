// YouTube 后台读取模块共用的失败结果：按失败码交回，形状不对的另带只影响这一项的标记。顶层只放函数。
import type { SiteFailure } from "../types.ts";

/** 形状不对以外的失败；说明是空的就不带。 */
export const fail = (code: Exclude<SiteFailure["code"], "MALFORMED">, detail?: string): SiteFailure => (detail ? { ok: false, code, detail } : { ok: false, code });
/** 页面交回的东西形状不对，只算这一项读不成。 */
export const malformed = (detail: string): SiteFailure => ({ ok: false, code: "MALFORMED", reach: "item", detail });
