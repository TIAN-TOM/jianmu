// 带评论区的结论提示词（PRD F23）：只在构建开关 FEATURE_COMMENTS 打开时进包，只从 prompts.ts 的开关分支引用。
import verdictComments from "prompt:skim/verdict-comments.md";

export const COMMENT_PROMPT_FILES = { "skim/verdict-comments.md": verdictComments };
