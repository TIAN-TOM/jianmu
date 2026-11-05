import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findStructureViolations, type SourceFile, type Violation } from "./helpers/structure-rules.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): SourceFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(name)) return [];
    return [{ path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }];
  });
}

function rulesHit(path: string, text: string): Violation["rule"][] {
  return findStructureViolations([{ path, text }]).map((violation) => violation.rule);
}

test("src/ 没有违反结构规则", () => {
  assert.deepEqual(findStructureViolations(sourceFiles(join(ROOT, "src"))), []);
});

describe("规则能拦下造好的违规", () => {
  test("第 1 条：依赖方向", () => {
    assert.deepEqual(rulesHit("src/core/a.ts", 'import { x } from "../platform/storage.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/platform/a.ts", 'import { x } from "../sites/rules.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/pages/a.ts", 'import { x } from "../background/router.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/background/a.ts", 'import { x } from "../sites/bilibili/service.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/content/bilibili.ts", 'import { x } from "../sites/bilibili/service.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/content/bilibili.ts", 'import { x } from "../sites/youtube/page.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/pages/a.ts", 'import { x } from "../sites/bilibili/url.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/background/a.ts", 'export { x } from "../pages/shared/api.ts";\n'), [1]);
  });

  test("第 1 条：放行合法的导入", () => {
    assert.deepEqual(rulesHit("src/background/a.ts", 'import { x } from "../sites/services.ts";\n'), []);
    assert.deepEqual(rulesHit("src/content/bilibili.ts", 'import { x } from "../sites/bilibili/page.ts";\n'), []);
    assert.deepEqual(rulesHit("src/pages/a.ts", 'import type { Cue } from "../sites/types.ts";\n'), []);
    assert.deepEqual(rulesHit("src/shared/a.ts", 'import type { VideoRef } from "../core/video-ref.ts";\n'), []);
  });

  test("第 1 条：core 不碰 chrome，.ts 不导入 .tsx", () => {
    assert.deepEqual(rulesHit("src/core/a.ts", "chrome.storage.local.get();\n"), [1]);
    assert.deepEqual(rulesHit("src/core/a.ts", '// chrome.storage 只在注释里\nconst s = "chrome.";\n'), []);
    assert.deepEqual(rulesHit("src/pages/a.ts", 'import { App } from "./app.tsx";\n'), [1]);
  });

  test("第 2 条：两站的主机名和路径只在 src/sites/", () => {
    assert.deepEqual(rulesHit("src/core/a.ts", 'const url = "https://www.bilibili.com/";\n'), [2]);
    assert.deepEqual(rulesHit("src/background/a.ts", 'const url = "/some/request/path";\n'), [2]);
    assert.deepEqual(rulesHit("src/core/ai/a.ts", 'const path = "/v1/messages";\n'), []);
    assert.deepEqual(rulesHit("src/sites/rules.ts", 'const host = "www.youtube.com";\n'), []);
    assert.deepEqual(rulesHit("src/core/a.ts", 'const key = "youtube:abc";\n'), []);
  });

  test("第 3 条：src/sites/ 的注释", () => {
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 见 https://example.com/doc\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 读 /some/request/path 的结果\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 读取/some/request/path的结果\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 见 sample.example.com/path\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 读字幕轨，速览/精读共用\n"), []);
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 一\n// 二\n// 三\n// 四\nconst a = 1;\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 一\n// 二\n// 三\nconst a = 1;\n"), []);
  });

  test("第 4 条：单个源文件不超过 500 行", () => {
    assert.deepEqual(rulesHit("src/core/a.ts", "const a = 1;\n".repeat(501)), [4]);
    assert.deepEqual(rulesHit("src/core/a.ts", "const a = 1;\n".repeat(500)), []);
  });

  test("第 5 条：注入页面的标识用 names.ts 的常量", () => {
    assert.deepEqual(rulesHit("src/content/shared/a.ts", 'node.id = "icon";\n'), [5]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", 'node.classList.add("icon");\n'), [5]);
    assert.deepEqual(rulesHit("src/sites/youtube/page.ts", 'node.style.setProperty("--size", "1px");\n'), [5]);
    assert.deepEqual(rulesHit("src/content/youtube-main.ts", 'window.dispatchEvent(new CustomEvent("reply"));\n'), [5]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", 'window.addEventListener("page-reply", run);\n'), [5]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", 'node.id = NAMES.icon;\nnode.addEventListener("click", run);\n'), []);
  });

  test("第 5 条：names.ts 的注入标识以 jianmu- 开头", () => {
    const text = (value: string): string => `export const INJECTED = {\n  icon: "${value}",\n} as const;\n`;
    assert.deepEqual(rulesHit("src/shared/names.ts", text("icon")), [5]);
    assert.deepEqual(rulesHit("src/shared/names.ts", text("jianmu-icon")), []);
    assert.deepEqual(rulesHit("src/shared/names.ts", text("--jianmu-size")), []);
  });

  test("第 6 条：B 站目录在评估完成前只有公开版", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/sign.ts", "export const a = 1;\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", "const r = ctx.fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const url = "https://example.com";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const url = "/some/request/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const url = "sample.example.com/some/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const host = "www.bilibili.com";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { read } from "./bilibili/full.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", "export const unavailable = true;\n"), []);
  });
});
