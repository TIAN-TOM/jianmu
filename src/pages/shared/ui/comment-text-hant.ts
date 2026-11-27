// 评论区那一块的繁体文案（PRD F23）：只从 comment-text.ts 引用，跟它一起只在构建开关 FEATURE_COMMENTS 打开时进包。
// 标签和章节标记的顺序和简体那份一样。顶层只放字面量和函数。
import type { CommentText } from "./comment-text.ts";

export const COMMENT_TEXT_HANT: CommentText = {
  title: "留言區",
  cardLabel: "留言",
  tags: ["好評居多", "有爭議", "有人指出錯誤", "說是標題黨", "留言還少"],
  marks: ["留言說有誤", "留言說可略過", "留言說精彩"],
  pinned: "置頂",
  likes: (count) => `讚 ${count}`,
  quotes: (count) => `${count} 則留言`,
};
