// 内置提示词：构建时内联进后台包，运行时不读文件。
// 按模式放：skim/ 是速览用的，study/ 是精读用的，common/ 是两种模式都用的。
import qa from "prompt:common/qa.md";
import chapters from "prompt:skim/chapters.md";
import verdict from "prompt:skim/verdict.md";
import explain from "prompt:study/explain.md";
import notePolish from "prompt:study/note-polish.md";
import translation from "prompt:study/translation.md";

export const PROMPT_FILES: Readonly<Record<string, string>> = Object.freeze({
  "common/qa.md": qa,
  "skim/chapters.md": chapters,
  "skim/verdict.md": verdict,
  "study/explain.md": explain,
  "study/note-polish.md": notePolish,
  "study/translation.md": translation,
});
