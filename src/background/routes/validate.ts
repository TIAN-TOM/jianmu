// 路由共用的形状核对：只看消息本身，不碰地址和存储。
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import { isPlainObject } from "../../shared/guards.ts";
import type { EmptyRequest } from "../../shared/messages/core.ts";

// 路由一律从这里取守卫，不直接导入 shared/guards.ts。
export { isPlainObject, isRecord, isTabId } from "../../shared/guards.ts";

/** 消息里的编号（任务、笔记、问答）最长多少。 */
export const MAX_ID = 100;

/** 用户输入的正文、问题、选中的文字和附近的字幕，原样能收多长：再长的不像是用户输入，按请求不对拒掉；超过各自上限的由服务按太长报。 */
export const RAW_TEXT_MAX = 20_000;

/** 不带参数的请求只收空对象，多带字段也拒。 */
export function isEmptyRequest(req: unknown): req is EmptyRequest {
  return isPlainObject(req) && Object.keys(req).length === 0;
}

/** 消息里的视频键要解析得出视频身份，空串和解析不出的都拒。 */
export function isVideoKey(value: unknown): value is VideoKey {
  return typeof value === "string" && parseVideoKey(value) !== null;
}

/** 键正好是 keys 这几个，不多不少。 */
export const hasOnly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** 必须有 required 里的键，别的键只能是 optional 里的。 */
export const keysWithin = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

/** 非空、不超过 MAX_ID 的字符串编号。 */
export const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

/** 不超过 RAW_TEXT_MAX 的字符串，空串也收。 */
export const isText = (value: unknown): value is string => typeof value === "string" && value.length <= RAW_TEXT_MAX;

/** 已经过 isVideoKey 核对的视频键转回视频身份。 */
export const refOf = (video: string): VideoRef => parseVideoKey(video) as VideoRef;
