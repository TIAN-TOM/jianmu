// 评论区那一块的文案（PRD F23）：只在构建开关 FEATURE_COMMENTS 打开时进包，只从开关分支引用。繁体在 comment-text-hant.ts。
// 口碑标签和章节标记按 core/ai/comments.ts 里 COMMENT_TAGS、MARK_KINDS 的顺序排，认不出的照原样写。顶层只放字面量和函数。
import { COMMENT_TAGS, MARK_KINDS, storedCommentView, type CommentView } from "../../../core/ai/comments.ts";
import { byLang } from "../ui-lang.ts";
import { COMMENT_TEXT_HANT } from "./comment-text-hant.ts";

export interface CommentText {
  readonly title: string;
  readonly cardLabel: string;
  /** 和 COMMENT_TAGS 一一对应。 */
  readonly tags: readonly string[];
  /** 和 MARK_KINDS 一一对应。 */
  readonly marks: readonly string[];
  readonly pinned: string;
  readonly likes: (count: number) => string;
  readonly quotes: (count: number) => string;
}

export const COMMENT_TEXT_ZH: CommentText = {
  title: "评论区",
  cardLabel: "评论",
  tags: ["好评居多", "有争议", "有人指出错误", "说是标题党", "评论还少"],
  marks: ["评论说有误", "评论说可跳过", "评论说精彩"],
  pinned: "置顶",
  likes: (count) => `赞 ${count}`,
  quotes: (count) => `${count} 条评论`,
};

export const COMMENT_TEXT_EN: CommentText = {
  title: "Comments",
  cardLabel: "Comments",
  tags: ["Mostly positive", "Divided", "Errors pointed out", "Called clickbait", "Few comments yet"],
  marks: ["Comments flag an error", "Comments say skip", "Comments' favourite"],
  pinned: "Pinned",
  likes: (count) => `${count} ${count === 1 ? "like" : "likes"}`,
  quotes: (count) => `${count} ${count === 1 ? "comment" : "comments"}`,
};

export const commentText = (): CommentText => byLang(COMMENT_TEXT_ZH, COMMENT_TEXT_EN, COMMENT_TEXT_HANT);

/** 口碑标签按界面语言的写法。 */
export const tagName = (tag: string, text: CommentText = commentText()): string => text.tags[COMMENT_TAGS.indexOf(tag)] ?? tag;
/** 章节标记按界面语言的写法。 */
export const markName = (kind: string, text: CommentText = commentText()): string => text.marks[MARK_KINDS.indexOf(kind)] ?? kind;

/** 结论里的评论区那一块，照形状再核一遍；形状不对时没有。 */
export const commentViewOfVerdict = (verdict: unknown): CommentView | null => storedCommentView((verdict as { readonly comments?: unknown } | null)?.comments);

/** 每一章旁边要写的评论标记，和章节一一对应；没有的是 null。 */
export function commentNotes(view: CommentView | null, chapterStarts: readonly number[], text: CommentText = commentText()): (string | null)[] {
  return chapterStarts.map((start) => {
    const kinds = view?.marks.filter((mark) => mark.start === start).map((mark) => markName(mark.kind, text)) ?? [];
    return kinds.length ? kinds.join(" · ") : null;
  });
}
