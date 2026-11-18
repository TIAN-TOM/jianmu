// 解释当前画面的提示词：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 prompts.ts 的开关分支引用。
import frameExplain from "prompt:study/frame-explain.md";

export const FRAME_PROMPT_FILES = { "study/frame-explain.md": frameExplain };
