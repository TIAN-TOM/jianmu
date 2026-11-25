// 构建产物检查：要先跑 npm run build。守的是产物，源码由结构测试守。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { build } from "esbuild";
import { bundleOptions, manifestFor } from "../scripts/build.mjs";
import { buildFlagsRecord, readBuildFlags } from "../scripts/lib/build-flags.mjs";
import { extractPromptSection } from "../src/core/ai/prompt.ts";
import {
  FEATURE_GLOBALS,
  FEATURE_NAMES,
  DAILY_FEATURES,
  RELEASE_FEATURES,
  TEST_BUILD_FEATURES,
  type FeatureName,
  type FeatureSet,
} from "../src/shared/features.ts";
import { INJECTED } from "../src/shared/names.ts";
import { FRAME_EXPLAIN_PROBE, KEEP_CONSENT_PROBE, YOUTUBE_OPEN_PANEL_PROBE, YOUTUBE_PLAYER_CAPTIONS_PROBE, YOUTUBE_PROBE } from "./fixtures/build-flags/gated.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const BUNDLES = ["background.js", "pages/sidepanel.js", "pages/theme-boot.js", "pages/card.js", "content/bilibili.js", "content/youtube.js", "content/youtube-bridge.js"];
// 权限只认这几项：多一项要改这里，不靠禁用名单列举。YouTube 和 AI 地址都走运行时申请的可选权限。
// scripting 用来在安装、更新和确认启用后往已开的视频页补注入内容脚本，本身没有安装警告。
// contextMenus 只用来在工具栏图标的右键菜单里加简幕自己的几项，也没有安装警告。
const PERMISSIONS = ["sidePanel", "storage", "scripting", "contextMenus"];
const HOST_PERMISSIONS = ["https://www.bilibili.com/*", "https://api.bilibili.com/*", "https://*.hdslb.com/*"];
// http 只放行本机的两个来源，不能写成 http://*/*。
const OPTIONAL_HOST_PERMISSIONS = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];

const readBuild = (file: string): string => readFileSync(join(BUILD, file), "utf8");

before(() => {
  assert.ok(existsSync(join(BUILD, "manifest.json")), "先跑 npm run build");
});

// 后台的全部顶层监听，都在入口一次注册。标签页激活、更新和窗口焦点给打开就出结论用，开关关着时醒来只读一次设置就返回。
// 授权增减给要另外授权的站（YouTube）注册内容脚本用，构建开关关着时醒来什么都不做。
// 侧边栏开了、关了这两个事件新一些的浏览器才有：有就听，记下哪些窗口开着侧边栏。
const TOP_LEVEL_LISTENERS = [
  "contextMenus.onClicked",
  "permissions.onAdded",
  "permissions.onRemoved",
  "runtime.onConnect",
  "runtime.onInstalled",
  "runtime.onMessage",
  "runtime.onStartup",
  "sidePanel.onClosed",
  "sidePanel.onOpened",
  "storage.onChanged",
  "tabs.onActivated",
  "tabs.onRemoved",
  "tabs.onUpdated",
  "windows.onFocusChanged",
];

test("后台包在替身环境里求值不抛错，监听都注册上", () => {
  let registered: string[] = [];
  const event = (name: string) => ({ addListener: (listener: unknown) => registered.push(`${name}:${typeof listener}`) });
  // 求值时只给事件：入口在顶层碰了存储、标签页或别的接口就会抛错。
  const chrome = {
    sidePanel: { onOpened: event("sidePanel.onOpened"), onClosed: event("sidePanel.onClosed") },
    runtime: Object.fromEntries(["onConnect", "onInstalled", "onMessage", "onStartup"].map((name) => [name, event(`runtime.${name}`)])),
    tabs: Object.fromEntries(["onActivated", "onRemoved", "onUpdated"].map((name) => [name, event(`tabs.${name}`)])),
    windows: { onFocusChanged: event("windows.onFocusChanged") },
    storage: { onChanged: event("storage.onChanged") },
    permissions: { onAdded: event("permissions.onAdded"), onRemoved: event("permissions.onRemoved") },
    contextMenus: { onClicked: event("contextMenus.onClicked") },
  };
  vm.runInNewContext(readBuild("background.js"), { chrome, console, TextEncoder, AbortController }, { filename: "background.js" });
  assert.deepEqual(registered.sort(), TOP_LEVEL_LISTENERS.map((name) => `${name}:function`));

  // 老一些的浏览器没有侧边栏的开关事件：照样求值，别的监听一个不少。
  registered = [];
  vm.runInNewContext(readBuild("background.js"), { chrome: { ...chrome, sidePanel: {} }, console, TextEncoder, AbortController }, { filename: "background.js" });
  assert.deepEqual(registered.sort(), TOP_LEVEL_LISTENERS.filter((name) => !name.startsWith("sidePanel.")).map((name) => `${name}:function`));
});

test("清单不变量", () => {
  const manifest = JSON.parse(readBuild("manifest.json"));
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, version);
  assert.deepEqual(manifest.permissions, PERMISSIONS);
  assert.deepEqual(manifest.host_permissions, HOST_PERMISSIONS);
  assert.deepEqual(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS);
  // 右键菜单第一行的扩展名链到这里。
  assert.equal(manifest.homepage_url, "https://github.com/TIAN-TOM/jianmu");
  // 名称、简介和图标提示按浏览器的界面语言从区域文件取，每个区域的文件都在构建里。
  assert.equal(manifest.default_locale, "en");
  for (const locale of readdirSync(join(ROOT, "static/_locales"))) assert.ok(existsSync(join(BUILD, "_locales", locale, "messages.json")), `构建里没有 _locales/${locale}`);
  // 网页能加载的只有卡片页，而且只能从每次会话都变的地址加载：卡片关着时网页拼不出能用的地址。发行构建对 B 站和 YouTube。
  assert.deepEqual(manifest.web_accessible_resources, [{ resources: ["pages/card.html"], matches: ["https://www.bilibili.com/*", "https://www.youtube.com/*"], use_dynamic_url: true }]);
  // 补注入按清单取脚本：清单里的每个脚本都在构建里。
  for (const script of manifest.content_scripts) {
    for (const file of script.js) assert.ok(existsSync(join(BUILD, file)), `构建里没有内容脚本 ${file}`);
  }
});

test("打开 YouTube 的构建里卡片页也对 YouTube 的页面开放，清单别的地方照模板；YouTube 关着的构建只对 B 站", () => {
  const template = JSON.parse(readFileSync(join(ROOT, "manifest.template.json"), "utf8"));
  const pristine = structuredClone(template);
  const both = [{ resources: ["pages/card.html"], matches: ["https://www.bilibili.com/*", "https://www.youtube.com/*"], use_dynamic_url: true }];
  for (const features of [RELEASE_FEATURES, DAILY_FEATURES, TEST_BUILD_FEATURES]) {
    const manifest = manifestFor(template, "1.2.3", features);
    assert.deepEqual(manifest.web_accessible_resources, both);
    assert.deepEqual({ ...manifest, web_accessible_resources: null }, { ...template, version: "1.2.3", web_accessible_resources: null });
  }
  for (const features of [{ ...RELEASE_FEATURES, youtube: false }, { ...TEST_BUILD_FEATURES, youtube: false }]) {
    assert.deepEqual(manifestFor(template, "1.2.3", features), { ...template, version: "1.2.3" });
  }
  assert.deepEqual(template, pristine, "不改模板本身");
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
  const cache = JSON.stringify({ accentTheme: "redblack", themeMode: "dark", uiFontScale: 112 });
  vm.runInNewContext(readBuild("pages/theme-boot.js"), {
    document: { documentElement: { dataset, style: { setProperty: (name: string, value: string) => (style[name] = value) } } },
    localStorage: { getItem: (key: string) => (key === "jianmu_appearance" ? cache : null) },
    matchMedia: () => ({ matches: false }),
  });
  assert.deepEqual({ dataset, style }, { dataset: { accentTheme: "redblack", themeMode: "dark" }, style: { "--ui-font-zoom": "1.12" } });
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
    assert.deepEqual(origins.filter((origin) => !/^(?:src\/|node_modules\/|prompts\/(?:skim|study|common)\/[^/]+\.md$)/.test(origin)), [], file);
  }
});

test("只给测试用的开发依赖（简繁字表 opencc-js）不进任何包", () => {
  const scripts = readdirSync(BUILD, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".js"));
  assert.ok(scripts.length >= BUNDLES.length);
  for (const file of scripts) assert.doesNotMatch(readBuild(file), /opencc/i, file);
});

// 各站 url.ts 旁边的繁体文字模块（url-hant.ts）跟着地址规则一起进包。
test("页面包里没有站点的后台读取代码", () => {
  for (const file of ["pages/sidepanel.js", "pages/card.js"]) {
    const origins = [...readBuild(file).matchAll(/^\s*\/\/ (src\/sites\/\S+)$/gm)].map((match) => match[1] ?? "");
    assert.deepEqual(origins.filter((origin) => !/^src\/sites\/(?:rules\.ts|[^/]+\/url(?:-hant)?\.ts)$/.test(origin)), [], file);
  }
});

test("内容脚本包里只有自己站的页面模块和地址规则，没有后台、页面和设置的代码", () => {
  const origins = [...readBuild("content/bilibili.js").matchAll(/^\s*\/\/ (src\/\S+)$/gm)].map((match) => match[1] ?? "");
  assert.ok(origins.includes("src/content/bilibili.ts"));
  assert.deepEqual(origins.filter((origin) => /^src\/(?:sites\/(?!bilibili\/(?:page|url|url-hant)\.ts)|background\/|pages\/|platform\/)|settings-schema/.test(origin)), []);
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

// 服务要读的提示词和小节：概览、解释、笔记润色、问答（用户消息分三块）、翻译、整理字幕、结论；按语言取规则的都带三套语言规则。
const PROMPT_SECTIONS: Readonly<Record<string, readonly string[]>> = {
  "skim/chapters.md": ["系统提示词", "用户提示词", "中文规则", "英文规则", "繁体中文规则"],
  "study/explain.md": ["系统提示词", "用户提示词", "中文规则", "英文规则", "繁体中文规则"],
  "study/note-polish.md": ["系统提示词", "用户提示词"],
  "common/qa.md": ["系统提示词", "用户消息：视频信息", "用户消息：字幕", "用户消息：问题", "中文规则", "英文规则", "繁体中文规则"],
  "study/translation.md": ["系统提示词", "用户提示词", "中文规则", "英文规则", "繁体中文规则"],
  "study/tidy.md": ["系统提示词", "用户提示词"],
  "skim/verdict.md": ["系统提示词", "用户提示词", "中文规则", "英文规则", "繁体中文规则"],
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

test("后台和各页面包注入的是同一个构建标识，由内容算出", () => {
  const idOf = (file: string): string | undefined => readBuild(file).match(/BUILD_ID = [^;]*?"([0-9a-f]{16})"/)?.[1];
  const background = idOf("background.js");
  assert.ok(background, "后台包里有构建标识");
  for (const file of ["pages/sidepanel.js", "pages/options.js", "pages/triage.js", "pages/card.js"]) assert.equal(idOf(file), background, file);
});

test("发行构建：开关记录和发行那份一样，包里没有留下没换掉的开关常量", () => {
  assert.deepEqual(readBuildFlags(), buildFlagsRecord(RELEASE_FEATURES), "build/ 不是发行构建，先跑 npm run build");
  for (const file of BUNDLES) {
    const bundle = readBuild(file);
    for (const name of Object.values(FEATURE_GLOBALS)) assert.ok(!bundle.includes(name), `${file} 里留着 ${name}`);
  }
});

// 用探针核对裁剪本身，和挂在开关下的产品代码无关：选项和真实的后台包一样，只换入口。
const PROBES: Readonly<Record<FeatureName, string>> = {
  frameExplain: FRAME_EXPLAIN_PROBE,
  youtube: YOUTUBE_PROBE,
  youtubeOpenPanel: YOUTUBE_OPEN_PANEL_PROBE,
  youtubeCaptionCatch: YOUTUBE_PLAYER_CAPTIONS_PROBE,
  keepConsent: KEEP_CONSENT_PROBE,
};

async function probeBundle(features: FeatureSet): Promise<string> {
  const [background] = bundleOptions(features);
  assert.ok(background, "没有后台包的构建选项");
  const result = await build({ ...background, entryPoints: [join(ROOT, "tests/fixtures/build-flags/probe.ts")], write: false });
  return result.outputFiles.map((output) => output.text).join("\n");
}

test("构建开关：关着的开关保护的内容整段裁掉，打开哪个开关才放进哪段", async () => {
  const variants: [string, FeatureSet][] = [
    ["发行构建", RELEASE_FEATURES],
    ["测试构建", TEST_BUILD_FEATURES],
    ...FEATURE_NAMES.map((name): [string, FeatureSet] => [`发行构建再${RELEASE_FEATURES[name] ? "关掉" : "打开"} ${name}`, { ...RELEASE_FEATURES, [name]: !RELEASE_FEATURES[name] }]),
  ];
  for (const [label, features] of variants) {
    const bundle = await probeBundle(features);
    for (const name of FEATURE_NAMES) assert.equal(bundle.includes(PROBES[name]), features[name], `${label}：${name} 保护的内容`);
    assert.equal(bundle.includes(":route"), features.frameExplain, `${label}：只从开关分支引用的函数`);
    for (const name of Object.values(FEATURE_GLOBALS)) assert.ok(!bundle.includes(name), `${label}：${name} 没换成字面量`);
  }
});

test("构建标识带上开关取值：只换开关重新构建，标识跟着变，同一组开关算出同一个", () => {
  const idOf = (features: FeatureSet): string[] => bundleOptions(features).map((options) => String(options.define?.["__JIANMU_BUILD_ID__"]));
  const release = idOf(RELEASE_FEATURES);
  assert.equal(new Set(release).size, 1, "各包同一个标识");
  assert.deepEqual(idOf(RELEASE_FEATURES), release);
  const ids = new Set([release[0], ...FEATURE_NAMES.map((name) => idOf({ ...RELEASE_FEATURES, [name]: !RELEASE_FEATURES[name] })[0])]);
  assert.equal(ids.size, FEATURE_NAMES.length + 1, "每种构建的标识都不一样");
  assert.ok(readBuild("background.js").includes(release[0] ?? "-"), "build/ 里的发行构建用的是发行开关算出的标识");
});

// 解释当前画面挂在开关下的内容：截帧代码、播放页图标、两份说明里当前一帧那几条、错误码和文案、
// 画面解释的功能槽、看图探测、提示词、路由和侧边栏里的按钮和结果。
const FRAME_SHARED = ["current-frame", "解释当前画面", "FRAME_PROTECTED", "AI_IMAGE_UNSUPPORTED", "画面解释", "frame.changed"];
const FRAME_MARKERS: Readonly<Record<string, readonly string[]>> = {
  "build/content/bilibili.js": ["requestVideoFrameCallback", "convertToBlob", "player.captureFrame", "解释当前画面", "frame.explainHere", "src/content/frame", "画面受保护", "Explain this frame", "Frame is protected"],
  "build/background.js": [...FRAME_SHARED, "prompts/study/frame-explain.md", "study/frame-explain.md", "frame.explain", "src/background/image-support", "src/background/services/frame-explain"],
  "build/pages/sidepanel.js": [...FRAME_SHARED, "frame.recent", "解释画面", "正在请模型看图", "Explain this frame"],
  "build/pages/options.js": [...FRAME_SHARED, "ai.probeImage", "能不能看图", "Frame explanation", "Check image support"],
};

async function bundlesWith(features: FeatureSet): Promise<Map<string, string>> {
  const wanted = bundleOptions(features).filter((options) => typeof options.outfile === "string" && options.outfile in FRAME_MARKERS);
  const built = await Promise.all(wanted.map(async (options) => [String(options.outfile), (await build({ ...options, write: false })).outputFiles.map((output) => output.text).join("\n")] as const));
  return new Map(built);
}

test("解释当前画面首发带上：发行构建的包里有截帧代码、图标、路由、提示词、按钮和当前一帧的说明；关掉开关的构建里都没有", async () => {
  const release = await bundlesWith(RELEASE_FEATURES);
  const off = await bundlesWith({ ...RELEASE_FEATURES, frameExplain: false });
  assert.equal(release.size, Object.keys(FRAME_MARKERS).length);
  for (const [file, markers] of Object.entries(FRAME_MARKERS)) {
    for (const marker of markers) {
      assert.ok(release.get(file)?.includes(marker), `发行构建的 ${file} 里没有 ${marker}`);
      assert.ok(readBuild(file.replace(/^build\//, "")).includes(marker), `build/ 里的 ${file} 没有 ${marker}`);
      assert.ok(!off.get(file)?.includes(marker), `关掉开关的 ${file} 里有 ${marker}`);
    }
  }
});

// YouTube 挂在开关下的内容：地址规则、内容脚本的注册、侧边栏和设置页的启用按钮、内容脚本本身。
const YOUTUBE_MARKERS: Readonly<Record<string, readonly string[]>> = {
  "build/background.js": ["www.youtube.com", "jianmu-youtube", "content/youtube.js", "content/youtube-bridge.js", "src/background/site-switch", "youtube.panel", "panel-shape", "src/sites/youtube/service", "src/sites/youtube/page/panel-types"],
  "build/pages/sidepanel.js": ["www.youtube.com", "在 YouTube 上启用", "Turn on for YouTube", "src/pages/shared/youtube-access"],
  "build/pages/options.js": ["www.youtube.com", "在 YouTube 上启用", "Turn on for YouTube", "src/pages/options/youtube-section"],
};

test("YouTube 首发带上：发行构建的包里有地址规则、脚本注册、启用按钮和它的内容脚本；关掉开关的构建里都没有，也不构建它的内容脚本", async () => {
  const pick = async (features: FeatureSet) => {
    const options = bundleOptions(features);
    const built = await Promise.all(
      options
        .filter((option) => typeof option.outfile === "string" && (option.outfile in YOUTUBE_MARKERS || option.outfile.startsWith("build/content/youtube")))
        .map(async (option) => [String(option.outfile), (await build({ ...option, write: false })).outputFiles.map((output) => output.text).join("\n")] as const),
    );
    return new Map(built);
  };
  const release = await pick(RELEASE_FEATURES);
  const off = await pick({ ...RELEASE_FEATURES, youtube: false });
  for (const file of ["build/content/youtube.js", "build/content/youtube-bridge.js"]) {
    assert.ok(release.has(file), `发行构建要有 ${file}`);
    assert.ok(existsSync(join(ROOT, file)), `build/ 里没有 ${file}`);
    assert.ok(!off.has(file), `关掉开关的构建不该构建 ${file}`);
  }
  // 主世界的小桥只带它自己和事件名：不带扩展接口，也不带内容脚本那一套。
  const bridge = release.get("build/content/youtube-bridge.js") ?? "";
  assert.ok(bridge.includes("src/sites/youtube/page/main-bridge") && bridge.includes(INJECTED.tracksAnswer), "发行构建要有 YouTube 主世界的小桥");
  for (const absent of ["chrome.", "src/content/app", "src/sites/youtube/page/read-panel", "src/core/"]) assert.ok(!bridge.includes(absent), `主世界的小桥里有 ${absent}`);
  for (const [file, markers] of Object.entries(YOUTUBE_MARKERS)) {
    for (const marker of markers) {
      assert.ok(release.get(file)?.includes(marker), `发行构建的 ${file} 里没有 ${marker}`);
      assert.ok(readBuild(file.replace(/^build\//, "")).includes(marker), `build/ 里的 ${file} 没有 ${marker}`);
      assert.ok(!off.get(file)?.includes(marker), `关掉开关的 ${file} 里有 ${marker}`);
    }
  }
});

test("YouTube 的内容脚本：两个开关都打开时有截帧代码和解释当前画面的图标，关掉解释当前画面的构建里没有", async () => {
  const pick = async (features: FeatureSet): Promise<string> => {
    const option = bundleOptions(features).find((candidate) => candidate.outfile === "build/content/youtube.js");
    assert.ok(option, "打开 YouTube 的构建要有它的内容脚本");
    return (await build({ ...option, write: false })).outputFiles.map((output) => output.text).join("\n");
  };
  const on = await pick(RELEASE_FEATURES);
  const off = await pick({ ...RELEASE_FEATURES, frameExplain: false });
  for (const marker of FRAME_MARKERS["build/content/bilibili.js"] ?? []) {
    assert.ok(on.includes(marker), `打开两个开关的 YouTube 内容脚本里没有 ${marker}`);
    assert.ok(!off.includes(marker), `关掉解释当前画面的 YouTube 内容脚本里有 ${marker}`);
  }
});

// 沿用同意只在开发者本人的日用包里：两份说明的条目变了照旧算数，侧边栏顶上说一句说明更新了。
const CARRY_MARKERS: Readonly<Record<string, readonly string[]>> = {
  "build/background.js": ["src/core/consent-carry", "src/shared/settings-carry"],
  "build/pages/sidepanel.js": ["src/pages/sidepanel/carried", "CarriedList", "说明更新了，多了几项", "看看多了什么", "See what's new"],
  "build/pages/options.js": ["src/core/consent-carry"],
};

test("沿用同意：日用包里有，发行包和 build/ 里都没有，对外的包照旧要重新确认、重新同意", async () => {
  const builds = async (features: FeatureSet): Promise<Map<string, string>> => {
    const wanted = bundleOptions(features).filter((options) => typeof options.outfile === "string" && options.outfile in CARRY_MARKERS);
    return new Map(await Promise.all(wanted.map(async (options) => [String(options.outfile), (await build({ ...options, write: false })).outputFiles.map((output) => output.text).join("\n")] as const)));
  };
  const [release, daily] = await Promise.all([builds(RELEASE_FEATURES), builds(DAILY_FEATURES)]);
  for (const [file, markers] of Object.entries(CARRY_MARKERS)) {
    for (const marker of markers) {
      assert.ok(!release.get(file)?.includes(marker), `发行构建的 ${file} 里有 ${marker}`);
      assert.ok(!readBuild(file.replace(/^build\//, "")).includes(marker), `build/ 里的 ${file} 有 ${marker}`);
      assert.ok(daily.get(file)?.includes(marker), `日用构建的 ${file} 里没有 ${marker}`);
    }
  }
});

test("YouTube 代开文字稿首发带上：发行构建的后台、侧边栏和 YouTube 内容脚本里有这条路由和它的代码，关掉开关的构建里没有", async () => {
  const pick = async (features: FeatureSet) => {
    const options = bundleOptions(features).filter((option) => ["build/background.js", "build/pages/sidepanel.js", "build/content/youtube.js"].includes(String(option.outfile)));
    const built = await Promise.all(options.map(async (option) => [String(option.outfile), (await build({ ...option, write: false })).outputFiles.map((output) => output.text).join("\n")] as const));
    return new Map(built);
  };
  const markers: Readonly<Record<string, readonly string[]>> = {
    "build/background.js": ["youtube.openTranscript", "src/background/routes/youtube"],
    // generate-read 是侧边栏的一步生成：还没读到字幕时「生成概览」先经视频页读，跟着代开开关走。
    "build/pages/sidepanel.js": ["youtube.openTranscript", "src/pages/sidepanel/open-transcript", "src/pages/sidepanel/generate-read"],
    // commands.ts 里还有读播放器字幕时开关字幕的点击，那个开关也进发行包，所以按代开用的函数体认，不按模块路径；
    // 关掉的构建里死分支还留着函数名，只有函数的定义会被裁掉。
    "build/content/youtube.js": ["youtube.openTranscript", "function createPanelOpener("],
  };
  const release = await pick(RELEASE_FEATURES);
  const withoutOpener = await pick({ ...RELEASE_FEATURES, youtubeOpenPanel: false });
  for (const [file, list] of Object.entries(markers)) {
    for (const marker of list) {
      assert.ok(release.get(file)?.includes(marker), `发行构建的 ${file} 里没有 ${marker}`);
      assert.ok(readBuild(file.replace(/^build\//, "")).includes(marker), `build/ 里的 ${file} 没有 ${marker}`);
      assert.ok(!withoutOpener.get(file)?.includes(marker), `关掉代开开关的 ${file} 里有 ${marker}`);
    }
  }
});

test("读播放器取回的字幕进发行包：发行构建和 build/ 的后台、YouTube 内容脚本和主世界小桥里有这段代码，关掉这个开关的构建里没有", async () => {
  const files = ["build/background.js", "build/content/youtube.js", "build/content/youtube-bridge.js"];
  const pick = async (features: FeatureSet) => {
    const options = bundleOptions(features).filter((option) => files.includes(String(option.outfile)));
    const built = await Promise.all(options.map(async (option) => [String(option.outfile), (await build({ ...option, write: false })).outputFiles.map((output) => output.text).join("\n")] as const));
    return new Map(built);
  };
  const markers: Readonly<Record<string, readonly string[]>> = {
    "build/background.js": ["youtube.caughtCaptions", "src/sites/youtube/player-fallback", "src/sites/youtube/caption-json", "src/sites/youtube/page/caption-types"],
    "build/content/youtube.js": ["youtube.caughtCaptions", "src/sites/youtube/page/caption-types", "ytp-subtitles-button", "src/sites/youtube/page/caption-ask"],
    "build/content/youtube-bridge.js": ["src/sites/youtube/page/caption-catch", "XMLHttpRequest", "src/sites/youtube/page/caption-types"],
  };
  const [release, off] = await Promise.all([pick(RELEASE_FEATURES), pick({ ...RELEASE_FEATURES, youtubeCaptionCatch: false })]);
  for (const [file, list] of Object.entries(markers)) {
    for (const marker of list) {
      assert.ok(release.get(file)?.includes(marker), `发行构建的 ${file} 里没有 ${marker}`);
      assert.ok(readBuild(file.replace(/^build\//, "")).includes(marker), `build/ 里的 ${file} 没有 ${marker}`);
      assert.ok(!off.get(file)?.includes(marker), `关掉读播放器字幕的构建里，${file} 有 ${marker}`);
    }
  }
});
