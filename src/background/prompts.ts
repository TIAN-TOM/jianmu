// 内置提示词：构建时内联进后台包，运行时不读文件。
// 按模式放：skim/ 是速读用的，study/ 是精读用的，common/ 是两种模式都用的。
// 解释当前画面的提示词只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，见 prompts-frame.ts。
import qa from "prompt:common/qa.md";
import chapters from "prompt:skim/chapters.md";
import verdict from "prompt:skim/verdict.md";
import explain from "prompt:study/explain.md";
import notePolish from "prompt:study/note-polish.md";
import tidy from "prompt:study/tidy.md";
import translation from "prompt:study/translation.md";
import { FRAME_PROMPT_FILES } from "./prompts-frame.ts";

export const PROMPT_FILES: Readonly<Record<string, string>> = Object.freeze({
  "common/qa.md": qa,
  "skim/chapters.md": chapters,
  "skim/verdict.md": verdict,
  "study/explain.md": explain,
  "study/note-polish.md": notePolish,
  "study/tidy.md": tidy,
  "study/translation.md": translation,
  ...(FEATURE_FRAME_EXPLAIN ? FRAME_PROMPT_FILES : {}),
});
