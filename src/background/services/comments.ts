// 生成概览时读评论区（PRD F23）：只在构建开关 FEATURE_COMMENTS 打开时进包，只从 app.ts 的开关分支引用。
// 经站点适配层读，YouTube 经视频所在的页面读；读不到（没登录、没有评论、被限流、页面不在前台）就当没有，概览照常生成。
import type { CommentInput } from "../../core/ai/comments.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import { parseVideoKey } from "../../core/video-ref.ts";
import type { VideoInfo } from "../../sites/types.ts";
import type { SiteAccess } from "./transcript/index.ts";

// 读评论最多等这么久，等不到就不带评论写结论，不拖住概览。
const COMMENT_READ_MS = 20_000;

export type CommentRead = (video: VideoKey, options: { readonly signal: AbortSignal; readonly tabId?: number | undefined }) => Promise<readonly CommentInput[] | null>;

export function createCommentRead(sites: SiteAccess): CommentRead {
  return async (video, { signal, tabId }) => {
    const ref = parseVideoKey(video);
    const site = ref ? sites.service(ref.platform) : undefined;
    if (!ref || !site?.readTopComments) return null;
    // 读评论只用得上视频身份：别的站点信息由适配层自己按需去读。
    const info: VideoInfo = { ref, title: "", author: "", description: "", durationSec: 0 };
    try {
      const result = await site.readTopComments(info, sites.ctx(ref.platform, { signal: AbortSignal.any([signal, AbortSignal.timeout(COMMENT_READ_MS)]), tabId }));
      return result.ok ? result.value : null;
    } catch {
      return null;
    }
  };
}
