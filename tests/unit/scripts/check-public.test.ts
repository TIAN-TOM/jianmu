import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations } from "../../../scripts/check-public.mjs";

test("合法路径不报", () => {
  const paths = [
    ".github/workflows/ci.yml",
    ".github/assets/sidepanel.png",
    ".github/assets/demo/overview.gif",
    "README.md",
    "README.en.md",
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
    "scripts/jianmu-extension.pem",
    "e2e/signing.key",
    "tests/fixtures/jianmu.crx",
    "tests/fixtures/KEY.PEM",
  ];
  const problems = findViolations(paths);
  for (const path of paths) {
    assert.ok(problems.some((problem) => problem.startsWith(`${path}：`)), `${path} 没被拦下`);
  }
});

test("README 的图片只放 .github/assets/，只许 PNG 和 GIF", () => {
  const paths = [".github/assets/a.jpg", ".github/assets/a.PNG", ".github/assets/a.svg", ".github/a.png", ".github/workflows/demo.gif", ".github/ISSUE_TEMPLATE/shot.webp"];
  const problems = findViolations(paths);
  for (const path of paths) {
    assert.ok(problems.some((problem) => problem.startsWith(`${path}：`)), `${path} 没被拦下`);
  }
  assert.deepEqual(findViolations(["static/icons/icon-128.png"]), []);
});

test(".github/assets/ 下单个文件超过 5 MB 就拦下，给了大小才查", () => {
  const limit = 5 * 1024 * 1024;
  const sizes: Record<string, number> = { ".github/assets/big.gif": limit + 1, ".github/assets/edge.gif": limit, ".github/workflows/ci.yml": limit * 2 };
  const sizeOf = (path: string): number | undefined => sizes[path];
  const paths = [...Object.keys(sizes), ".github/assets/gone.png"];
  assert.deepEqual(findViolations(paths, { sizeOf }), [".github/assets/big.gif：超过 5 MB"]);
  assert.deepEqual(findViolations(paths), []);
});
