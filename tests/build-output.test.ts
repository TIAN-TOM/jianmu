// 构建产物检查：要先跑 npm run build。守的是产物，源码由结构测试守。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { extractPromptSection } from "../src/core/ai/prompt.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const BUNDLES = ["background.js", "pages/sidepanel.js"];
// 权限只认这几项：多一项要改这里，不靠禁用名单列举。YouTube 和 AI 地址都走运行时申请的可选权限。
const PERMISSIONS = ["sidePanel", "storage"];
const HOST_PERMISSIONS = ["https://www.bilibili.com/*", "https://api.bilibili.com/*", "https://*.hdslb.com/*"];
const OPTIONAL_HOST_PERMISSIONS = ["https://*/*"];

const readBuild = (file: string): string => readFileSync(join(BUILD, file), "utf8");

before(() => {
  assert.ok(existsSync(join(BUILD, "manifest.json")), "先跑 npm run build");
});

test("后台包在替身环境里求值不抛错，监听都注册上", () => {
  const listeners: unknown[] = [];
  const chrome = {
    runtime: { onInstalled: { addListener: (listener: unknown) => listeners.push(listener) } },
    sidePanel: { setPanelBehavior: async () => undefined },
  };
  vm.runInNewContext(readBuild("background.js"), { chrome, console }, { filename: "background.js" });
  assert.equal(listeners.length, 1);
});

test("清单不变量", () => {
  const manifest = JSON.parse(readBuild("manifest.json"));
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.permissions, PERMISSIONS);
  assert.deepEqual(manifest.host_permissions, HOST_PERMISSIONS);
  assert.deepEqual(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test("包里的源文件注释只来自 src/、prompts/ 和依赖包", () => {
  for (const file of BUNDLES) {
    const origins = [...readBuild(file).matchAll(/^\s*\/\/ ((?:src|prompts|tests|node_modules|\.\.)[^\s]*\.(?:[cm]?[jt]sx?|md))$/gm)].map((match) => match[1] ?? "");
    assert.ok(origins.length > 0, `${file} 没有源文件注释`);
    assert.deepEqual(origins.filter((origin) => !/^(?:src\/|node_modules\/|prompts\/[^/]+\.md$)/.test(origin)), [], file);
  }
});

test("页面包里没有站点的后台读取代码", () => {
  const origins = [...readBuild("pages/sidepanel.js").matchAll(/^\s*\/\/ (src\/sites\/\S+)$/gm)].map((match) => match[1] ?? "");
  assert.deepEqual(origins.filter((origin) => !/^src\/sites\/(?:rules\.ts|[^/]+\/url\.ts)$/.test(origin)), []);
});

test("包里没有 source map 引用", () => {
  for (const file of BUNDLES) assert.doesNotMatch(readBuild(file), /sourceMappingURL/);
});

// 服务要读的提示词和小节：概览、解释、笔记润色、问答、翻译（含两套语言规则）、结论。
const PROMPT_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  "analysis.md": ["系统提示词", "用户提示词"],
  "explain.md": ["系统提示词", "用户提示词"],
  "note-cleanup.md": ["系统提示词", "用户提示词"],
  "qa.md": ["系统提示词", "用户提示词"],
  "translation.md": ["系统提示词", "用户提示词", "中文规则", "英文规则"],
  "verdict.md": ["系统提示词", "用户提示词"],
};

/** 包里内联的模板全文：源文件注释下面那个字符串字面量的值。 */
function inlinedPrompt(bundle: string, file: string): string {
  const literal = new RegExp(`// prompts/${file.replace(".", "\\.")}\\n\\s*var \\w+ = (.+);\\n`).exec(bundle)?.[1];
  assert.ok(literal, `${file} 没有内联进后台包`);
  return String(vm.runInNewContext(literal));
}

test("运行时代码引用的提示词文件与小节名都存在", () => {
  const bundle = readBuild("background.js");
  for (const [file, headings] of Object.entries(PROMPT_SECTIONS)) {
    const inlined = inlinedPrompt(bundle, file);
    assert.equal(inlined, readFileSync(join(ROOT, "prompts", file), "utf8"), `${file} 内联后和源文件不一致`);
    for (const heading of headings) {
      assert.ok(extractPromptSection(inlined, heading).trim().length > 0, `${file}#${heading} 是空的`);
    }
  }
});

test("包里带项目和打进包的依赖的许可声明", () => {
  const licenses = readBuild("LICENSE.txt");
  assert.ok(licenses.startsWith("MIT License"), "项目自己的许可在最前面");
  for (const holder of ["TIAN-TOM", "k1234567", "Zara Zhang"]) assert.ok(licenses.includes(holder), `缺 ${holder}`);
  for (const name of ["preact", "@preact/signals", "@preact/signals-core"]) {
    assert.ok(licenses.includes(`\n${name}\n`), `缺 ${name} 的许可`);
  }
  assert.ok(!licenses.includes("\r"));
});
