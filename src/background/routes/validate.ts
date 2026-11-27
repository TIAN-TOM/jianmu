// 路由共用的形状核对：只看消息本身，不碰地址和存储。
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import { isPlainObject } from "../../shared/guards.ts";
import type { EmptyRequest } from "../../shared/messages/core.ts";

// 路由一律从这里取守卫，不直接导入 shared/guards.ts。
export { isPlainObject, isRecord, isTabId } from "../../shared/guards.ts";

/** 不带参数的请求只收空对象，多带字段也拒。 */
export function isEmptyRequest(req: unknown): req is EmptyRequest {
  return isPlainObject(req) && Object.keys(req).length === 0;
}

/** 消息里的视频键要解析得出视频身份，空串和解析不出的都拒。 */
export function isVideoKey(value: unknown): value is VideoKey {
  return typeof value === "string" && parseVideoKey(value) !== null;
}
