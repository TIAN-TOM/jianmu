// 内置提示词：构建时内联进后台包，运行时不读文件。
import analysis from "prompt:analysis.md";
import explain from "prompt:explain.md";
import noteCleanup from "prompt:note-cleanup.md";
import qa from "prompt:qa.md";
import translation from "prompt:translation.md";
import verdict from "prompt:verdict.md";

export const PROMPT_FILES: Readonly<Record<string, string>> = Object.freeze({
  "analysis.md": analysis,
  "explain.md": explain,
  "note-cleanup.md": noteCleanup,
  "qa.md": qa,
  "translation.md": translation,
  "verdict.md": verdict,
});
