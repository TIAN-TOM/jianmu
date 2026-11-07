import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AV_XOR_CODE, BV_ALPHABET } from "../src/sites/bilibili/url.ts";
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

// 几个文件一起查，结果写成「规则号 文件」，看得出是谁犯的。
function filesHit(files: Readonly<Record<string, string>>): string[] {
  const list = Object.entries(files).map(([path, text]) => ({ path, text }));
  return findStructureViolations(list).map(({ rule, file }) => `${rule} ${file}`);
}

test("src/ 没有违反结构规则", () => {
  assert.deepEqual(findStructureViolations(sourceFiles(join(ROOT, "src"))), []);
});

test("内容脚本、卡片、侧边栏都用共用模块，自己不再留一份换算", () => {
  const constants = [String(AV_XOR_CODE), BV_ALPHABET];
  const holders = sourceFiles(join(ROOT, "src")).filter(({ text }) => constants.some((value) => text.includes(value)));
  assert.deepEqual(holders.map(({ path }) => path), ["src/sites/bilibili/url.ts"]);
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
    assert.deepEqual(rulesHit("src/background/a.ts", 'const host = "sample.hdslb.com";\n'), [2]);
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

  test("第 3 条：src/sites 的注释只写用途", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "// B 站接口要求的请求签名。\nexport const a = 1;\n"), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "// 字段见接口文档。\nexport const a = 1;\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "// 实测会回这个结果。\nexport const a = 1;\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "// 取 sample_field 字段。\nexport const a = 1;\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "// 回 -999 时重来。\nexport const a = 1;\n"), [3]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "// 回 12345 时报不存在。\nexport const a = 1;\n"), [3]);
    assert.deepEqual(rulesHit("src/core/a.ts", "// 实测会回这个结果。\nexport const a = 1;\n"), []);
  });

  test("第 6 条：代码不读 Cookie", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", "const c = document.cookie;\n"), [6]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", 'const c = document["cookie"];\n'), [6]);
    assert.deepEqual(rulesHit("src/background/a.ts", "const c = document?.cookie;\n"), [6]);
    assert.deepEqual(rulesHit("src/background/a.ts", "chrome?.cookies.getAll({});\n"), [6]);
    assert.deepEqual(rulesHit("src/background/a.ts", "chrome.cookies.getAll({});\n"), [6]);
    assert.deepEqual(rulesHit("src/pages/a.ts", "cookieStore.getAll();\n"), [6]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", "const { cookie } = document;\n"), [6]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", "const doc = document; doc.cookie;\n"), [6]);
    assert.deepEqual(rulesHit("src/content/shared/a.ts", 'Reflect.get(document, "cookie");\n'), [6]);
    assert.deepEqual(rulesHit("src/core/a.ts", 'const tip = "不读 Cookie 内容";\n'), [], "文案里的大写 Cookie 不算读取");
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const init = { credentials: "include" };\n'), []);
  });

  test("第 6 条：不设表明身份的请求头", () => {
    for (const name of ["Cookie", "User-Agent", "Referer", "Origin", "X-Client-Name", "Sec-Fetch-Site"]) {
      assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", `const h = { "${name}": "x" };\n`), [6]);
    }
    for (const key of ["Cookie", "Referer", "referer", "Origin"]) {
      assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", `const h = { ${key}: value };\n`), [6]);
    }
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "const h = { cookie: value };\n"), [6, 6], "小写的 cookie 同时算读取和设请求头");
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const h = { Accept: "application/json", "Accept-Language": "zh-CN" };\n'), []);
    assert.deepEqual(rulesHit("src/core/ai/a.ts", 'const h = { "x-api-key": key };\n'), []);
  });

  test("第 6 条：B 站读取只请求放行表里的地址", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const a = "https://api.bilibili.com/x/web-interface/view";\n'), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "const r = await ctx.fetch(url, init);\n"), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/captions.ts", "const r = await ctx.fetch(url, init);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/captions.ts", "const go = ctx.fetch;\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/captions.ts", 'const r = await ctx["fetch"](url);\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/captions.ts", "const { fetch: go } = ctx;\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/captions.ts", "new XMLHttpRequest();\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "const go = ctx.fetch;\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", 'const r = await ctx["fetch"](url);\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/http.ts", "const r = await globalThis.fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const a = url.replace(/^http:/, "https://");\n'), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", "const r = await fetch(url, init);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/sign.ts", 'const a = "https://api.bilibili.com/some/other/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const a = "/some/request/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", 'const a = "sample.example.com/some/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/service.ts", "const a = `${origin}/some/path`;\n"), [6]);
  });

  test("第 6 条：url.ts、page.ts 不发请求，不导入后台读取代码", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", "await fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/page.ts", "new XMLHttpRequest();\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { sign } from "./sign.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'import { read } from "./service.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { parse } from "./url.ts";\n'), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", "const a = `https://www.bilibili.com/video/${id}`;\n"), []);
  });

  test("第 6 条：services.ts 只经各站的 service.ts 取服务", () => {
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { read } from "./bilibili/sign.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { read } from "./bilibili/service.ts";\n'), []);
  });

  test("第 6 条：services.ts 按规范化后的路径查，绕一圈的写法也拦", () => {
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { createBiliHttp } from "../sites/bilibili/http.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { createHttp } from "./youtube/http.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { read } from "./bilibili/../bilibili/captions.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { read } from "./bilibili/parts/service.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'import { siteRules } from "./rules.ts";\n'), [6]);
    const ok = 'import { createBilibiliService } from "../sites/bilibili/service.ts";\nimport type { SiteCtx } from "./types.ts";\n';
    assert.deepEqual(rulesHit("src/sites/services.ts", ok), []);
  });

  test("第 6 条：url.ts、page.ts 按规范化后的路径查，经别的模块转手带入的也算", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { createBilibiliService } from "../bilibili/service.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'import type { BiliHttp } from "./http.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { youtubeRules } from "../youtube/url.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/page-types.ts", 'import type { SiteService } from "./services.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { bilibiliRules } from "./parts/../url.ts";\n'), []);
    const viaRules = {
      "src/sites/rules.ts": 'export { createBilibiliService } from "./bilibili/service.ts";\n',
      "src/sites/bilibili/page.ts": 'import { createBilibiliService } from "../rules.ts";\n',
    };
    assert.deepEqual(filesHit(viaRules), ["6 src/sites/rules.ts", "6 src/sites/rules.ts", "6 src/sites/bilibili/page.ts"]);
    const viaCore = {
      "src/core/relay.ts": 'export { createBiliHttp } from "../sites/bilibili/http.ts";\n',
      "src/sites/bilibili/page.ts": 'import { createBiliHttp } from "../../core/relay.ts";\n',
    };
    assert.deepEqual(filesHit(viaCore), ["1 src/core/relay.ts", "6 src/sites/bilibili/page.ts"]);
    const sendingCore = {
      "src/core/net.ts": "export const get = (url: string) => fetch(url);\n",
      "src/sites/bilibili/page.ts": 'import { get } from "../../core/net.ts";\n',
    };
    assert.deepEqual(filesHit(sendingCore), ["6 src/sites/bilibili/page.ts"]);
  });

  test("第 6 条：rules.ts 只从各站的 url.ts 取值，重导出也一样", () => {
    assert.deepEqual(rulesHit("src/sites/rules.ts", 'export { createBilibiliService } from "./bilibili/service.ts";\n'), [6, 6]);
    assert.deepEqual(rulesHit("src/sites/rules.ts", 'export * from "./bilibili/../bilibili/http.ts";\n'), [6, 6]);
    assert.deepEqual(rulesHit("src/sites/rules.ts", 'import { videoKey } from "../core/video-ref.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/rules.ts", 'export * from "./types.ts";\n'), [6]);
    const ok = [
      'import type { Platform } from "../core/video-ref.ts";',
      'import { bilibiliRules } from "./bilibili/url.ts";',
      'export type { SiteRules } from "./types.ts";',
      'export { bilibiliRules as defaultRules } from "./bilibili/url.ts";',
    ];
    assert.deepEqual(rulesHit("src/sites/rules.ts", `${ok.join("\n")}\n`), []);
  });

  test("第 6 条：src/sites/ 下的文件都查网络调用，只放行请求出口和交给读取环境的那一处", () => {
    assert.deepEqual(rulesHit("src/sites/request.ts", "export const get = (url: string) => fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/service.ts", "const r = await fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", "const ctx = { fetch: fetch.bind(globalThis) };\n"), []);
    const twice = "const a = { fetch: fetch.bind(globalThis) };\nconst b = { fetch: fetch.bind(globalThis) };\n";
    assert.deepEqual(rulesHit("src/sites/services.ts", twice), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", "const ctx = { fetch: globalThis.fetch };\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/types.ts", "export interface Ctx {\n  fetch: typeof fetch;\n}\n"), []);
    assert.deepEqual(rulesHit("src/sites/types.ts", "export const go = (url: string) => fetch(url);\n"), [6]);
  });

  test("第 6 条：地址放行表也查站点根下和别的站点目录", () => {
    assert.deepEqual(rulesHit("src/sites/request.ts", 'const a = "https://api.bilibili.com/some/other/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/service.ts", 'const a = "/some/request/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/services.ts", 'const a = "https://api.bilibili.com/x/web-interface/view";\n'), []);
    assert.deepEqual(rulesHit("src/sites/youtube/url.ts", 'const a = "/some/request/path";\n'), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'export const A = "https://api.bilibili.com/some/other/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'export const A = "api.bilibili.com/some/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'export const A = "https://www.bilibili.com/video/x";\n'), []);
  });

  test("第 6 条：内容脚本不发请求，契约文件也不转手后台读取代码", () => {
    assert.deepEqual(rulesHit("src/content/bilibili.ts", 'export const load = () => fetch(location.href);\n'), [6]);
    const viaTypes = {
      "src/content/bilibili.ts": 'import "../sites/types.ts";\n',
      "src/sites/types.ts": 'export { createBilibiliService } from "./bilibili/service.ts";\n',
    };
    assert.deepEqual(filesHit(viaTypes), ["6 src/sites/types.ts"]);
  });

  test("第 6 条：B 站读取的请求只从 http.ts 出去，不经公共请求封装", () => {
    const viaSites = {
      "src/sites/request.ts": 'export const getJson = () => fetch("https://api.bilibili.com/some/other/path");\n',
      "src/sites/bilibili/captions.ts": 'import { getJson } from "../request.ts";\nexport const read = () => getJson();\n',
    };
    assert.deepEqual(filesHit(viaSites), ["6 src/sites/request.ts", "6 src/sites/request.ts", "6 src/sites/bilibili/captions.ts"]);
    const viaPlatform = {
      "src/platform/net.ts": "export const get = (url: string) => fetch(url);\n",
      "src/sites/bilibili/captions.ts": 'import { get } from "../../platform/net.ts";\nexport const read = () => get(VIEW_URL);\n',
    };
    assert.deepEqual(filesHit(viaPlatform), ["6 src/sites/bilibili/captions.ts"]);
    const viaExit = {
      "src/platform/net.ts": "export const get = (url: string) => fetch(url);\n",
      "src/sites/bilibili/http.ts": 'export { get } from "../../platform/net.ts";\n',
      "src/sites/bilibili/captions.ts": 'import { get } from "./http.ts";\n',
    };
    assert.deepEqual(filesHit(viaExit), ["6 src/sites/bilibili/http.ts", "6 src/sites/bilibili/captions.ts"]);
  });

  test("第 6 条：经 http.ts 发请求、只导入类型，都不算绕过请求出口", () => {
    const viaHttp = {
      "src/sites/bilibili/http.ts": "export const send = (ctx: Ctx, url: string) => ctx.fetch(url);\n",
      "src/sites/bilibili/captions.ts": 'import { send } from "./http.ts";\n',
    };
    assert.deepEqual(filesHit(viaHttp), []);
    const typeOnly = {
      "src/core/net.ts": "export interface Net {\n  fetch: typeof fetch;\n}\n",
      "src/sites/bilibili/captions.ts": 'import type { Net } from "../../core/net.ts";\n',
      "src/sites/bilibili/page.ts": 'import type { Net } from "../../core/net.ts";\n',
    };
    assert.deepEqual(filesHit(typeOnly), []);
  });
});
