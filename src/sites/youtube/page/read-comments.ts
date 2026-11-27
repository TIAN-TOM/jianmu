// 读观看页上已经加载出来的评论（PRD F23、第 8.2 节第 9 条）：只看不动，不点、不滚、不发请求。
// 只读每条顶层评论的正文、点赞数和是否置顶，不读昵称、头像和评论者的频道。只在构建开关 FEATURE_COMMENTS 打开时进包。
import type { VideoRef } from "../../../core/video-ref.ts";
import { COMMENT_LIMITS, likesOf, type CommentReply, type CommentRequest, type PageComment } from "./comment-types.ts";
import { videoOnPage } from "./panel-dom.ts";
import { squash } from "./values.ts";

// 评论区和其中的每一条顶层评论；回复在另一块里，不读。
export const COMMENT_SECTION = "ytd-comments#comments";
const THREADS = "ytd-comment-thread-renderer";
const TOP_LEVEL = "#comment-container";
const TEXT = "#content-text";
const LIKES = "#vote-count-middle";
const PINNED_BADGE = "#pinned-comment-badge";

/** 页面上已经加载出来的顶层评论，最多 COMMENT_LIMITS.count 条。 */
export function loadedComments(document: Document): PageComment[] {
  const section = document.querySelector(COMMENT_SECTION);
  if (!section) return [];
  const comments: PageComment[] = [];
  for (const thread of Array.from(section.querySelectorAll(THREADS))) {
    if (comments.length >= COMMENT_LIMITS.count) break;
    const top = thread.querySelector(TOP_LEVEL);
    const text = squash(top?.querySelector(TEXT)?.textContent).slice(0, COMMENT_LIMITS.text);
    if (!top || !text) continue;
    const pinned = squash(top.querySelector(PINNED_BADGE)?.textContent) !== "";
    comments.push({ text, likes: likesOf(top.querySelector(LIKES)?.textContent), pinned });
  }
  return comments;
}

export interface CommentReaderDeps {
  readonly document: Document;
  readonly currentRef: () => VideoRef | null;
}

export interface CommentReader {
  /** 认得的请求回 Promise，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<CommentReply> | null;
}

export function createCommentReader({ document, currentRef }: CommentReaderDeps): CommentReader {
  return {
    handle(message) {
      const request = message as Partial<CommentRequest> | null;
      if (request?.type !== "youtube.comments" || typeof request.req?.videoId !== "string") return null;
      const videoId = videoOnPage(document, currentRef());
      // 页面上不是问的那个视频时不交评论，免得把上一个视频的评论算到这一个头上。
      return Promise.resolve({ videoId, comments: videoId === request.req.videoId ? loadedComments(document) : [] });
    },
  };
}
