// 概览里评论区那一步（PRD F23）：只在构建开关 FEATURE_COMMENTS 打开时进包，只从 generate.ts 的开关分支引用。
// 生成概览时和分块请求同时读评论，写结论时交进去；补失败块不再读评论，沿用原来那份，章节标记只留还对得上的。
import { commentMaterial, storedCommentView, type CommentMaterial } from "../../../core/ai/comments.ts";
import type { Verdict } from "../../../core/ai/verdict.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import type { CommentRead } from "../comments.ts";

export interface CommentAsk {
  readonly video: VideoKey;
  readonly signal: AbortSignal;
  /** 要读评论的任务才有（卡片、侧边栏点的，打开就出结论）；本窗口全部生成、补失败块没有。 */
  readonly comments?: { readonly tabId?: number | undefined } | undefined;
}

export interface CommentStage {
  /** 开始读：不读的任务、读不到时交回 undefined。从不抛错。 */
  readonly start: (ask: CommentAsk) => Promise<CommentMaterial | undefined>;
  /** 重写结论时没有新读的评论：沿用原来那份，章节标记只留还对得上现有章节的。 */
  readonly carry: (verdict: Verdict, previous: unknown, chapterStarts: readonly number[]) => Verdict;
}

export function commentStage(read: CommentRead | undefined): CommentStage {
  return {
    async start({ video, signal, comments }) {
      if (!read || !comments) return undefined;
      const found = await read(video, { signal, tabId: comments.tabId }).catch(() => null);
      return found ? commentMaterial(found) : undefined;
    },
    carry(verdict, previous, chapterStarts) {
      if (verdict.comments) return verdict;
      const kept = storedCommentView((previous as { readonly comments?: unknown } | null)?.comments);
      if (!kept) return verdict;
      const starts = new Set(chapterStarts);
      return { ...verdict, comments: { ...kept, marks: kept.marks.filter((mark) => starts.has(mark.start)) } };
    },
  };
}
