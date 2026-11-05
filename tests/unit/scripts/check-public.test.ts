import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations } from "../../../scripts/check-public.mjs";

test("合法路径不报", () => {
  const paths = [
    ".github/workflows/ci.yml",
    "README.md",
    "notes/product-prd.md",
    "notes/manual-checklist.md",
    "package-lock.json",
    "tsconfig.sw.json",
    "src/core/video-ref.ts",
    "static/_locales/zh_CN/messages.json",
    "tests/fixtures/golden/chunking.json",
  ];
  assert.deepEqual(findViolations(paths), []);
});

test("拦下不该进仓库的路径", () => {
  const paths = [
    "experiments/lab/extension/a.js",
    "src/spike/a.ts",
    "notes/interface-analysis.md",
    "build/background.js",
    "dist/jianmu-0.1.0.zip",
    "src/background/main.js.map",
    ".env",
    "tests/.env.local",
    "e2e/session.har",
    "e2e/debug.log",
    "src/.DS_Store",
    "results/export.json",
    "e2e/export.json",
    ".vscode/settings.json",
    "profile/Default/Preferences",
  ];
  const problems = findViolations(paths);
  for (const path of paths) {
    assert.ok(problems.some((problem) => problem.startsWith(`${path}：`)), `${path} 没被拦下`);
  }
});
