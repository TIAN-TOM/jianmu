// 构建产物检查：要先跑 npm run build。守的是产物，源码由结构测试守。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { extractPromptSection } from "../src/core/ai/prompt.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const BUNDLES = ["background.js", "pages/sidepanel.js", "pages/theme-boot.js", "pages/card.js", "content/bilibili.js"];
// 权限只认这几项：多一项要改这里，不靠禁用名单列举。YouTube 和 AI 地址都走运行时申请的可选权限。
// scripting 用来在安装、更新和确认启用后往已开的视频页补注入内容脚本，本身没有安装警告。
const PERMISSIONS = ["sidePanel", "storage", "scripting"];
const HOST_PERMISSIONS = ["https://www.bilibili.com/*", "https://api.bilibili.com/*", "https://*.hdslb.com/*"];
const OPTIONAL_HOST_PERMISSIONS = ["https://*/*"];

const readBuild = (file: string): string => readFileSync(join(BUILD, file), "utf8");

before(() => {
  assert.ok(existsSync(join(BUILD, "manifest.json")), "先跑 npm run build");
});

// 后台的全部顶层监听，都在入口一次注册。标签页激活、更新和窗口焦点不在里面：没有开关时注册它们只会让后台白白醒来。
const TOP_LEVEL_LISTENERS = [
  "runtime.onConnect",
  "runtime.onInstalled",
  "runtime.onMessage",
  "runtime.onStartup",
  "storage.onChanged",
  "tabs.onRemoved",
];

test("后台包在替身环境里求值不抛错，监听都注册上", () => {
  const registered: string[] = [];
  const event = (name: string) => ({ addListener: (listener: unknown) => registered.push(`${name}:${typeof listener}`) });
  // 求值时只给事件：入口在顶层碰了存储、标签页或别的接口就会抛错。
  const chrome = {
    runtime: Object.fromEntries(["onConnect", "onInstalled", "onMessage", "onStartup"].map((name) => [name, event(`runtime.${name}`)])),
    tabs: { onRemoved: event("tabs.onRemoved") },
    storage: { onChanged: event("storage.onChanged") },
  };
  vm.runInNewContext(readBuild("background.js"), { chrome, console, TextEncoder, AbortController }, { filename: "background.js" });
  assert.deepEqual(registered.sort(), TOP_LEVEL_LISTENERS.map((name) => `${name}:function`));
});

test("清单不变量", () => {
  const manifest = JSON.parse(readBuild("manifest.json"));
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.permissions, PERMISSIONS);
  assert.deepEqual(manifest.host_permissions, HOST_PERMISSIONS);
  assert.deepEqual(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS);
  // 网页能加载的只有卡片页，而且只能从每次会话都变的地址加载：卡片关着时网页拼不出能用的地址。
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ["pages/card.html"], matches: ["https://www.bilibili.com/*"], use_dynamic_url: true }]);
  // 补注入按清单取脚本：清单里的每个脚本都在构建里。
  for (const script of manifest.content_scripts) {
    for (const file of script.js) assert.ok(existsSync(join(BUILD, file)), `构建里没有内容脚本 ${file}`);
  }
});

const PACKAGE_FILES = readFileSync(join(ROOT, "tests/fixtures/package-files.txt"), "utf8").split("\n").filter(Boolean);

test("四个扩展页面都在 <head> 里、样式表之前同步加载主题启动脚本，并且打进包里", () => {
  const pages = readdirSync(join(BUILD, "pages")).filter((name) => name.endsWith(".html"));
  assert.ok(pages.includes("sidepanel.html"), "至少有侧边栏");
  for (const page of pages) {
    const html = readBuild(`pages/${page}`);
    const head = html.slice(0, html.indexOf("</head>"));
    const scripts = [...head.matchAll(/<script\b[^>]*>/g)];
    const first = scripts[0];
    assert.ok(first && /\bsrc="\.\/theme-boot\.js"/.test(first[0]), `${page}：<head> 里第一个脚本是首帧外观脚本`);
    assert.doesNotMatch(first[0], /\b(?:async|defer|type)\b/, `${page}：要同步执行，第一帧之前写好`);
    const stylesheet = head.search(/<link\b[^>]*\brel="stylesheet"/);
    assert.ok(stylesheet === -1 || first.index < stylesheet, `${page}：要放在样式表前面`);
    assert.match(head, /<link rel="stylesheet" href="\.\.\/theme\.css" \/>/, `${page}：加载共用的主题样式表`);
    for (const [tag] of scripts) assert.match(tag, /\bsrc="/, `${page}：MV3 不允许内联脚本`);
  }
  for (const file of ["pages/theme-boot.js", "theme.css"]) {
    assert.ok(existsSync(join(BUILD, file)), `构建里没有 ${file}`);
    assert.ok(PACKAGE_FILES.includes(file), `${file} 要进包`);
  }

  // 打出来的是经典脚本：在一个假的页面里求值，按缓存同步写好 <html>
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const cache = JSON.stringify({ accentTheme: "ochre", themeMode: "dark", uiFontScale: 112 });
  vm.runInNewContext(readBuild("pages/theme-boot.js"), {
    document: { documentElement: { dataset, style: { setProperty: (name: string, value: string) => (style[name] = value) } } },
    localStorage: { getItem: (key: string) => (key === "jianmu_appearance" ? cache : null) },
    matchMedia: () => ({ matches: false }),
  });
  assert.deepEqual({ dataset, style }, { dataset: { accentTheme: "ochre", themeMode: "dark" }, style: { "--ui-font-zoom": "1.12" } });
});

test("扩展页面紧跟着主题样式表加载共用组件的样式表，组件样式都进包", () => {
  const pages = readdirSync(join(BUILD, "pages")).filter((name) => name.endsWith(".html"));
  for (const page of pages) {
    const html = readBuild(`pages/${page}`);
    const head = html.slice(0, html.indexOf("</head>"));
    const sheets = [...head.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(sheets.slice(0, 2), ["../theme.css", "../ui.css"], `${page}：先变量后组件`);
  }
  // 组件样式按用途分了几份，由 ui.css 引进来：每一份都在构建里、进包。
  const parts = [...readBuild("ui.css").matchAll(/@import url\("\.\/([^"]+)"\);/g)].map((match) => match[1] ?? "");
  assert.ok(parts.length > 0, "ui.css 没有引进组件样式");
  for (const file of ["ui.css", ...parts]) {
    assert.ok(existsSync(join(BUILD, file)), `构建里没有 ${file}`);
    assert.ok(PACKAGE_FILES.includes(file), `${file} 要进包`);
  }
});

const ICON_SIZES = [16, 48, 128];
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** PNG 里每一块的类型，按出现顺序。 */
function pngChunks(png: Buffer): string[] {
  const types: string[] = [];
  for (let offset = 8; offset + 8 <= png.length; offset += 12 + png.readUInt32BE(offset)) types.push(png.toString("latin1", offset + 4, offset + 8));
  return types;
}

test("扩展图标是 16、48、128 三档 PNG：尺寸对得上，工具栏用同一套，都进包，不带文字信息块", () => {
  const manifest = JSON.parse(readBuild("manifest.json"));
  const icons = Object.fromEntries(ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]));
  assert.deepEqual(manifest.icons, icons);
  assert.deepEqual(manifest.action.default_icon, icons);
  for (const [size, file] of Object.entries(icons)) {
    const png = readFileSync(join(BUILD, file));
    assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE, `${file} 不是 PNG`);
    const chunks = pngChunks(png);
    assert.equal(chunks[0], "IHDR");
    assert.equal(chunks.at(-1), "IEND");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Number(size), Number(size)], `${file} 的尺寸`);
    // 只有图像数据：作者、软件名、注释这类文字块和元数据不进包
    assert.deepEqual(chunks.filter((type) => !["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type)), [], file);
    assert.ok(PACKAGE_FILES.includes(file), `${file} 要进包`);
  }
});

test("包里的源文件注释只来自 src/、prompts/ 和依赖包", () => {
  for (const file of BUNDLES) {
    const origins = [...readBuild(file).matchAll(/^\s*\/\/ ((?:src|prompts|tests|node_modules|\.\.)[^\s]*\.(?:[cm]?[jt]sx?|md))$/gm)].map((match) => match[1] ?? "");
    assert.ok(origins.length > 0, `${file} 没有源文件注释`);
    assert.deepEqual(origins.filter((origin) => !/^(?:src\/|node_modules\/|prompts\/[^/]+\.md$)/.test(origin)), [], file);
  }
});

test("页面包里没有站点的后台读取代码", () => {
  for (const file of ["pages/sidepanel.js", "pages/card.js"]) {
    const origins = [...readBuild(file).matchAll(/^\s*\/\/ (src\/sites\/\S+)$/gm)].map((match) => match[1] ?? "");
    assert.deepEqual(origins.filter((origin) => !/^src\/sites\/(?:rules\.ts|[^/]+\/url\.ts)$/.test(origin)), [], file);
  }
});

test("内容脚本包里只有自己站的页面模块和地址规则，没有后台、页面和设置的代码", () => {
  const origins = [...readBuild("content/bilibili.js").matchAll(/^\s*\/\/ (src\/\S+)$/gm)].map((match) => match[1] ?? "");
  assert.ok(origins.includes("src/content/bilibili.ts"));
  assert.deepEqual(origins.filter((origin) => /^src\/(?:sites\/(?!bilibili\/(?:page|url)\.ts)|background\/|pages\/|platform\/)|settings-schema/.test(origin)), []);
});

test("后台包带着 B 站的读取实现和取字幕服务", () => {
  const origins = new Set([...readBuild("background.js").matchAll(/^\s*\/\/ (src\/\S+)$/gm)].map((match) => match[1] ?? ""));
  for (const origin of ["src/sites/bilibili/service.ts", "src/sites/bilibili/sign.ts", "src/sites/services.ts", "src/background/services/transcript/index.ts"]) {
    assert.ok(origins.has(origin), `后台包里没有 ${origin}`);
  }
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
