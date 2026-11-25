// 写结论时带上评论区（PRD F23）：只在构建开关 FEATURE_COMMENTS 打开时进包，只从 conclude.ts 的开关分支引用。
// 评论太少就不发给模型，本机直接记「评论还少」；够了就换用带评论区的提示词和输出格式，模型写回来的那一块按发出去的那批评论核对。
import { commentViewOf, COMMENT_MIN, fewComments, type CommentMaterial } from "../../../core/ai/comments.ts";
import { VERDICT_WITH_COMMENTS } from "../../../core/ai/schemas-comments.ts";
import type { ResponseSchema } from "../../../core/ai/schemas.ts";
import type { Verdict } from "../../../core/ai/verdict.ts";
import type { OutputLang } from "../../../core/output-lang.ts";

export const COMMENT_VERDICT_PROMPT = "skim/verdict-comments.md";
// 多写评论区那一块，给的输出上限比只写结论的大一些。
const COMMENT_VERDICT_MAX_TOKENS = 2048;

export interface CommentPlan {
  /** 发给模型：换用带评论区的提示词、输出格式和上限，多填评论那一段。 */
  readonly send?: { readonly variables: { readonly commentsText: string }; readonly schema: ResponseSchema; readonly maxTokens: number };
  /** 把评论区那一块挂到结论上；正文被截断时评论区排在最后，多半只剩半截，整块不要。 */
  readonly attach: (parsed: unknown, verdict: Verdict, chapterStarts: readonly unknown[], lang: OutputLang, truncated: boolean) => Verdict;
}

export function commentPlan(material: CommentMaterial): CommentPlan {
  if (material.kept.length < COMMENT_MIN) return { attach: (_parsed, verdict) => ({ ...verdict, comments: fewComments() }) };
  return {
    send: { variables: { commentsText: material.text }, schema: VERDICT_WITH_COMMENTS, maxTokens: COMMENT_VERDICT_MAX_TOKENS },
    attach(parsed, verdict, chapterStarts, lang, truncated) {
      if (truncated) return verdict;
      const view = commentViewOf((parsed as { readonly comments?: unknown } | null)?.comments, material.kept, chapterStarts, lang);
      return view ? { ...verdict, comments: view } : verdict;
    },
  };
}
