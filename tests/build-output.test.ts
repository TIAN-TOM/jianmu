// 构建产物检查：要先跑 npm run build。守的是产物，源码由结构测试守。
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const BUNDLES = ["background.js", "pages/sidepanel.js"];
const FORBIDDEN_PERMISSIONS = ["tabs", "activeTab", "cookies", "downloads", "debugger", "tabCapture", "desktopCapture"];

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
  assert.deepEqual(manifest.permissions.filter((name: string) => FORBIDDEN_PERMISSIONS.includes(name)), []);
  // 安装时不要 YouTube 和宽泛的主机权限：这些只走运行时申请的可选权限。
  for (const host of manifest.host_permissions ?? []) {
    assert.doesNotMatch(host, /youtube|<all_urls>|^\*:|^https:\/\/\*\/\*$/);
  }
  assert.equal(manifest.web_accessible_resources, undefined);
});

test("包里的源文件注释只来自 src/ 和依赖包", () => {
  for (const file of BUNDLES) {
    const origins = [...readBuild(file).matchAll(/^\s*\/\/ ((?:src|tests|node_modules|\.\.)[^\s]*\.[cm]?[jt]sx?)$/gm)].map((match) => match[1] ?? "");
    assert.ok(origins.length > 0, `${file} 没有源文件注释`);
    assert.deepEqual(origins.filter((origin) => !/^(?:src|node_modules)\//.test(origin)), [], file);
  }
});

test("包里没有 source map 引用", () => {
  for (const file of BUNDLES) assert.doesNotMatch(readBuild(file), /sourceMappingURL/);
});
