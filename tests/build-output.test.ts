// 构建产物检查：要先跑 npm run build。守的是产物，源码由结构测试守。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.ok(!licenses.includes("\r"));
});

/** 包里源文件注释指向的依赖包名，作用域包取两段；嵌套安装的取最里面那个。 */
function bundledPackages(bundle: string): string[] {
  const names = new Set<string>();
  for (const [, origin = ""] of bundle.matchAll(/^\s*\/\/ (node_modules\/\S+)$/gm)) {
    const name = [...origin.matchAll(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].at(-1)?.[1];
    assert.ok(name, `认不出包名：${origin}`);
    names.add(name);
  }
  return [...names].sort();
}

test("打进包的每个依赖都有自己的许可证一节，仓库 LICENSE 的版权行原样都在", () => {
  const licenses = readBuild("LICENSE.txt");
  const headings = new Set(licenses.split("\n\n---\n\n").map((section) => section.split("\n", 1)[0]));
  const packages = BUNDLES.flatMap((file) => bundledPackages(readBuild(file)));
  assert.ok(packages.length > 0, "包里没有依赖包的源文件注释");
  for (const name of new Set(packages)) assert.ok(headings.has(name), `${name} 打进了包，LICENSE.txt 里没有它的许可证一节`);

  const copyrights = readFileSync(join(ROOT, "LICENSE"), "utf8").split("\n").filter((line) => line.startsWith("Copyright "));
  assert.equal(copyrights.length, 3, "仓库 LICENSE 应有三行版权");
  for (const line of copyrights) assert.ok(licenses.includes(`\n${line}\n`), `LICENSE.txt 缺这行版权：${line}`);
});

// 扩展 ID 由清单 key 里的公钥决定：公钥的 SHA-256 取前 32 个十六进制字符，0–f 换成 a–p。
function extensionIdOf(publicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

test("清单带固定的 key，算出的扩展 ID 等于快照", () => {
  const { key } = JSON.parse(readBuild("manifest.json"));
  assert.equal(typeof key, "string", "清单缺 key：没有它，扩展 ID 跟着加载的文件夹走，换文件夹资料就接不上");
  const expected = readFileSync(join(ROOT, "tests/fixtures/extension-id.txt"), "utf8").trim();
  assert.equal(extensionIdOf(key), expected, "key 换了：已装用户的资料会接不上");
});
