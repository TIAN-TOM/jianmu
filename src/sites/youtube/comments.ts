// YouTube 的评论区（PRD F23、第 8.2 节第 9 条）：经视频所在的页面读，不向平台发请求。
// 先读页面上已经加载出来的；没有时请页面替用户滚过去一次（页面自己判断前台、广告、用户在不在动），加载出来再读一遍。
// 只在构建开关 FEATURE_COMMENTS 打开时进包，只从 service.ts 的开关分支引用。
import type { PageChannel, SiteCtx, SiteFailure, SiteResult, TopComment, VideoInfo } from "../types.ts";
import { fail, malformed } from "./failure.ts";
import { commentReplyOf, loadReplyOf, type CommentReply, type LoadOutcome } from "./page/comment-types.ts";

export type PageAsk = (page: PageChannel, message: unknown, signal: AbortSignal, limitMs: number) => Promise<{ ok: true; answer: unknown } | { ok: false; failure: SiteFailure }>;

// 只读页面上已有的，页面当场就答。
const READ_TIMEOUT_MS = 3_000;
// 滚过去等评论加载：页面那头最多等 6 秒，再留一点余量。
const LOAD_TIMEOUT_MS = 10_000;

async function readLoaded(ask: PageAsk, page: PageChannel, videoId: string, ctx: SiteCtx): Promise<SiteResult<CommentReply>> {
  const asked = await ask(page, { type: "youtube.comments", req: { videoId } }, ctx.signal, READ_TIMEOUT_MS);
  if (!asked.ok) return asked.failure;
  const reply = commentReplyOf(asked.answer);
  if (!reply) return malformed("comments-shape");
  if (reply.videoId !== videoId) return fail("VIDEO_CHANGED", "comments");
  return { ok: true, value: reply };
}

const asTop = (reply: CommentReply): TopComment[] => reply.comments.map(({ text, likes, pinned }) => ({ text, likes, pinned }));

/** 滚不成的几种结果各自报成读不到，原因写在 detail 里；视频对不上单独报。 */
function failureOf(outcome: Exclude<LoadOutcome, "loaded">): SiteFailure {
  return outcome === "video-changed" ? fail("VIDEO_CHANGED", "load-comments") : fail("UNAVAILABLE", `comments-${outcome}`);
}

export function pageCommentReader(ask: PageAsk): (info: VideoInfo, ctx: SiteCtx) => Promise<SiteResult<TopComment[]>> {
  return async (info, ctx) => {
    const page = ctx.page;
    if (!page) return fail("UNAVAILABLE", "no-page");
    const videoId = info.ref.videoId;
    const first = await readLoaded(ask, page, videoId, ctx);
    if (!first.ok || first.value.comments.length > 0) return first.ok ? { ok: true, value: asTop(first.value) } : first;
    const asked = await ask(page, { type: "youtube.loadComments", req: { videoId } }, ctx.signal, LOAD_TIMEOUT_MS);
    if (!asked.ok) return asked.failure;
    const load = loadReplyOf(asked.answer);
    if (!load) return malformed("load-shape");
    if (load.outcome !== "loaded") return failureOf(load.outcome);
    const second = await readLoaded(ask, page, videoId, ctx);
    return second.ok ? { ok: true, value: asTop(second.value) } : second;
  };
}
