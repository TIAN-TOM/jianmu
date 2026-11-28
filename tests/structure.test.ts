import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundlesFor } from "../scripts/lib/bundles.mjs";
import { FEATURE_NAMES, type FeatureSet } from "../src/shared/features.ts";
import { AV_XOR_CODE, BV_ALPHABET } from "../src/sites/bilibili/url.ts";
import { DUPLICATE_ALLOWED, findStructureViolations, SCRIPT_ONLY, UNIMPORTED_ALLOWED, type SourceFile, type Violation } from "./helpers/structure-rules.ts";

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

// 第 9 条认的入口：开关全开时要打的全部包的入口。
const ALL_ON = Object.fromEntries(FEATURE_NAMES.map((name) => [name, true])) as FeatureSet;
const ENTRIES: ReadonlySet<string> = new Set(bundlesFor(ALL_ON).flatMap((bundle) => bundle.entryPoints));

test("src/ 没有违反结构规则", () => {
  assert.deepEqual(findStructureViolations(sourceFiles(join(ROOT, "src")), { entries: ENTRIES }), []);
});

test("第 9、10 条：只给脚本读的文件和放行表里的文件都还在", () => {
  const duplicates = Object.keys(DUPLICATE_ALLOWED).map((key) => key.slice(0, key.indexOf(" ")));
  const gone = [...Object.keys(SCRIPT_ONLY), ...Object.keys(UNIMPORTED_ALLOWED), ...duplicates].filter((path) => !existsSync(join(ROOT, path)));
  assert.deepEqual(gone, [], "文件删掉了，表里那一条也要删");
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
    assert.deepEqual(rulesHit("src/sites/a.ts", "// 读字幕轨，速读/精读共用\n"), []);
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

  test("第 6 条：url.ts、page.ts 不发请求，不导入后台读取代码，只写播放页地址", () => {
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", "await fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/page.ts", "new XMLHttpRequest();\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { sign } from "./sign.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'import { read } from "./service.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'import { parse } from "./url.ts";\n'), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", "const a = `https://www.bilibili.com/video/${id}`;\n"), []);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'export const A = "/some/request/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'const a = "/some/request/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", "const a = `${origin}/some/path`;\n"), [6]);
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
    assert.deepEqual(rulesHit("src/sites/youtube/url.ts", 'const a = "/some/request/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'export const A = "https://api.bilibili.com/some/other/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page.ts", 'export const A = "api.bilibili.com/some/path";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'export const A = "https://www.bilibili.com/video/x";\n'), []);
  });

  test("第 6 条：内容脚本不发请求，也不直接或间接带入发请求的模块；契约文件也不转手后台读取代码", () => {
    assert.deepEqual(rulesHit("src/content/bilibili.ts", 'export const load = () => fetch(location.href);\n'), [6]);
    const viaTypes = {
      "src/content/bilibili.ts": 'import "../sites/types.ts";\n',
      "src/sites/types.ts": 'export { createBilibiliService } from "./bilibili/service.ts";\n',
    };
    assert.deepEqual(filesHit(viaTypes), ["6 src/sites/types.ts"]);
    const net = "export interface Net {\n  fetch: typeof fetch;\n}\nexport const get = (url: string) => fetch(url);\n";
    const direct = { "src/core/net.ts": net, "src/content/bilibili.ts": 'import { get } from "../core/net.ts";\n' };
    assert.deepEqual(filesHit(direct), ["6 src/content/bilibili.ts"]);
    const relayed = {
      "src/core/net.ts": net,
      "src/core/relay.ts": 'export { get } from "./net.ts";\n',
      "src/content/bilibili.ts": 'import { get } from "../core/relay.ts";\n',
    };
    assert.deepEqual(filesHit(relayed), ["6 src/content/bilibili.ts"]);
    const typeOnly = { "src/core/net.ts": net, "src/content/bilibili.ts": 'import type { Net } from "../core/net.ts";\n' };
    assert.deepEqual(filesHit(typeOnly), []);
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

  test("第 7 条：值的导入不成环，只导入类型的边不算", () => {
    const pair = {
      "src/core/a.ts": 'import { b } from "./b.ts";\nexport const a = 1;\n',
      "src/core/b.ts": 'import { a } from "./a.ts";\nexport const b = 2;\n',
    };
    assert.deepEqual(filesHit(pair), ["7 src/core/a.ts"]);
    const ring = {
      "src/background/x.ts": 'import { y } from "./y.ts";\n',
      "src/background/y.ts": 'export { z as y } from "./z.ts";\n',
      "src/background/z.ts": 'import "./x.ts";\n',
    };
    assert.deepEqual(filesHit(ring), ["7 src/background/x.ts"]);
    assert.deepEqual(rulesHit("src/core/a.ts", 'import { a } from "./a.ts";\n'), [7]);
    const inlineType = {
      "src/core/a.ts": 'import { type B } from "./b.ts";\nexport const a = 1;\n',
      "src/core/b.ts": 'import { a } from "./a.ts";\nexport type B = number;\n',
    };
    assert.deepEqual(filesHit(inlineType), ["7 src/core/a.ts"], "只在花括号里写 type 的导入照样加载模块，算值的边");
    const typeOnly = {
      "src/core/a.ts": 'import type { B } from "./b.ts";\nexport const a = 1;\n',
      "src/core/b.ts": 'import { a } from "./a.ts";\nexport type B = number;\n',
    };
    assert.deepEqual(filesHit(typeOnly), []);
    const chain = {
      "src/core/a.ts": 'import { b } from "./b.ts";\n',
      "src/core/b.ts": 'import { c } from "./c.ts";\n',
      "src/core/c.ts": "export const c = 1;\n",
    };
    assert.deepEqual(filesHit(chain), []);
  });

  test("第 8 条：core 不导入 shared/messages", () => {
    assert.deepEqual(rulesHit("src/core/notes/a.ts", 'import type { TextTarget } from "../../shared/messages/translate.ts";\n'), [8]);
    assert.deepEqual(rulesHit("src/core/a.ts", 'import type { Msg } from "../shared/messages.ts";\n'), [8]);
    assert.deepEqual(rulesHit("src/core/a.ts", 'export type { Msg } from "../shared/messages/../messages/ai.ts";\n'), [8]);
    assert.deepEqual(rulesHit("src/core/a.ts", 'import { NAMES } from "../shared/names.ts";\n'), []);
    assert.deepEqual(rulesHit("src/core/a.ts", 'import { list } from "../shared/messages-list.ts";\n'), []);
    assert.deepEqual(rulesHit("src/shared/messages/a.ts", 'import type { TranscriptRef } from "../../core/notes/records.ts";\n'), []);
    assert.deepEqual(rulesHit("src/background/a.ts", 'import type { TranslateOut } from "../shared/messages/translate.ts";\n'), []);
  });

  test("第 9 条：src/ 下每个模块都有 src/ 里的导入方", () => {
    const entries: ReadonlySet<string> = new Set(["src/background/main.ts"]);
    const wholeHit = (files: Readonly<Record<string, string>>, given = entries): string[] =>
      findStructureViolations(Object.entries(files).map(([path, text]) => ({ path, text })), { entries: given }).map(({ rule, file }) => `${rule} ${file}`);
    const orphan = {
      "src/background/main.ts": 'import { a } from "../core/a.ts";\n',
      "src/core/a.ts": "export const a = 1;\n",
      "src/core/unused.ts": "export const u = 1;\n",
    };
    assert.deepEqual(wholeHit(orphan), ["9 src/core/unused.ts"]);
    assert.deepEqual(wholeHit(orphan, new Set()), ["9 src/background/main.ts", "9 src/core/unused.ts"], "不在入口集合里的入口文件也要有导入方");
    assert.deepEqual(filesHit(orphan), [], "不给入口集合时不查第 9 条");
    const used = {
      "src/background/main.ts": 'import type { A } from "../core/a.ts";\nimport "../core/side.ts";\n',
      "src/core/a.ts": "export type A = number;\n",
      "src/core/side.ts": "globalThis.x = 1;\n",
      "src/shared/build-flags.d.ts": "declare const FLAG: boolean;\n",
      "src/shared/features.ts": "export const RELEASE_FEATURES = {};\n",
      "src/core/notes/filter.ts": "export const filter = 1;\n",
    };
    assert.deepEqual(wholeHit(used), [], "只导入类型、只为副作用导入都算有导入方；入口、.d.ts 和放行表里的不查");
    const selfOnly = {
      "src/background/main.ts": "export const main = 1;\n",
      "src/core/lonely.ts": 'import type { L } from "./lonely.ts";\nexport type L = number;\n',
    };
    assert.deepEqual(wholeHit(selfOnly), ["9 src/core/lonely.ts"], "只有自己导入自己不算");
    const wired = {
      "src/background/main.ts": 'import { filter } from "../core/notes/filter.ts";\n',
      "src/core/notes/filter.ts": "export const filter = 1;\n",
    };
    assert.deepEqual(wholeHit(wired), ["9 src/core/notes/filter.ts"], "放行表里的模块接进产品以后，这一条要从放行表删掉");
  });

  test("第 10 条：逐字相同的顶层函数定义只留一份", () => {
    const arrow = 'const clean = (value: unknown): string => (typeof value === "string" ? value.trim() : "");\n';
    assert.deepEqual(filesHit({ "src/core/a.ts": `export ${arrow}`, "src/pages/b.ts": arrow }), ["10 src/core/a.ts", "10 src/pages/b.ts"], "去掉 export 再比");
    const fn = 'function pick(list: readonly string[], index: number): string {\n  return list[index] ?? "";\n}\n';
    const reflowed = 'export function pick(list: readonly string[],   index: number): string {\n    // 注释不算\n    return list[index] ?? "";\n}\n';
    assert.deepEqual(filesHit({ "src/core/a.ts": fn, "src/background/b.ts": reflowed, "src/content/c.ts": `${fn}const x = 1;\n` }), ["10 src/core/a.ts", "10 src/background/b.ts", "10 src/content/c.ts"]);
  });

  test("第 10 条：太短的、只在一个文件里的、名字不同的和放行表里的不拦，放行表里用不上的条目要删", () => {
    const short = "const one = (value: number): number => value + 1;\n";
    assert.deepEqual(filesHit({ "src/core/a.ts": short, "src/pages/b.ts": short }), []);
    const arrow = '(value: unknown): string => (typeof value === "string" ? value.trim() : "");\n';
    assert.deepEqual(filesHit({ "src/core/a.ts": `const clean = ${arrow}` }), []);
    assert.deepEqual(filesHit({ "src/core/a.ts": `const clean = ${arrow}`, "src/pages/b.ts": `const tidy = ${arrow}` }), []);
    assert.deepEqual(filesHit({ "src/core/a.ts": `const clean = ${arrow}`, "src/pages/b.ts": `const clean = { size: 1 };\n` }), []);
    const table = 'export const frameText = (lang: UiLang): FrameText => inLang(lang, FRAME_ZH, FRAME_EN, FRAME_HANT);\n';
    assert.deepEqual(filesHit({ "src/pages/options/frame-text.ts": table, "src/pages/sidepanel/frame-text.ts": table }), []);
    assert.deepEqual(filesHit({ "src/pages/options/frame-text.ts": table, "src/pages/card/frame-text.ts": table }), ["10 src/pages/card/frame-text.ts"], "放行只按文件加名字");
    assert.deepEqual(filesHit({ "src/pages/options/frame-text.ts": table }), ["10 src/pages/options/frame-text.ts"], "不再和别处重复的放行条目要删");
  });

  test("第 11 条：语言参数不写缺省值", () => {
    const defaults = [
      'export const textOf = (lang: UiLang = "zh"): Text => inLang(lang, A, B, C);',
      'export function describe(code: ErrorCode, detail?: string, lang: OutputLang = "zh"): string {}',
      'function notes(list: Notes, { grouped = false, lang = "zh" }: Options = {}) {}',
      'function looks(text: string, targetLang = "en"): boolean {}',
      'function target(lang: string, outputLang: OutputLang = "zh-Hant"): OutputLang {}',
      'export function createStore({ api, lang = () => "zh" }: Deps): Store {}',
      'const { api, lang = (): UiLang => "zh" } = deps;',
      'export function createAiStatus(lang: () => UiLang = () => "zh"): AiStatus {}',
      'export function createMenu({ settings, uiLanguage = () => "zh", ...deps }: Deps): Menu {}',
      'const lang = deps.outputLang ?? "zh";',
      'const lang = (): UiLang => deps.lang?.() ?? "zh";',
      'const uiLanguage = deps.uiLanguage ?? ((): string => "zh");',
    ];
    for (const line of defaults) assert.deepEqual(rulesHit("src/core/a.ts", `${line}\n`), [11], line);
    assert.deepEqual(rulesHit("src/pages/b.tsx", 'export function A({ lang = "en" }: Props) {}\n'), [11], ".tsx 也查");
  });

  test("第 11 条：明确传的语言、比较、局部变量、别的设置值和注释不拦", () => {
    const fine = [
      "export const textOf = (lang: UiLang): Text => inLang(lang, A, B, C);",
      'const text = textOf("zh");',
      'if (lang === "zh") run();',
      'const same = lang !== "en";',
      'const lang = "zh";',
      'export type OutputLang = "zh" | "zh-Hant" | "en";',
      'let targetLang = "en";',
      'const setting = saved?.language ?? "auto";',
      'const ok = validateBaseUrl(url, protocol, "zh");',
      'return isOutputLang(lang) ? lang : "zh";',
      '// 以前写成 lang = "zh"',
    ];
    for (const line of fine) assert.deepEqual(rulesHit("src/core/a.ts", `${line}\n`), [], line);
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

describe("第 6 条：YouTube 一侧的边界", () => {
  test("url.ts 只许写放行表里的主机匹配规则，只放行 YouTube 站点那一条", () => {
    assert.deepEqual(rulesHit("src/sites/youtube/url.ts", 'export const P = "https://www.youtube.com/*";\n'), []);
    for (const pattern of ["https://*.youtube.com/*", "*://www.youtube.com/*", "https://www.youtube.com/watch*", "<all_urls>", "https://*/*"]) {
      assert.deepEqual(rulesHit("src/sites/youtube/url.ts", `export const P = "${pattern}";\n`), [6], pattern);
    }
    assert.deepEqual(rulesHit("src/sites/youtube/page.ts", 'export const P = "https://www.youtube.com/*";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/url.ts", 'export const P = "https://www.youtube.com/*";\n'), [6]);
  });

  test("src/sites/youtube/ 下任何文件都不发请求，也不带入发请求的模块", () => {
    assert.deepEqual(rulesHit("src/sites/youtube/http.ts", "const r = await ctx.fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/service.ts", "const ctx = { fetch: fetch.bind(globalThis) };\n"), [6]);
    const viaBilibiliExit = {
      "src/sites/bilibili/http.ts": "export const send = (ctx: Ctx, url: string) => ctx.fetch(url);\n",
      "src/sites/youtube/service.ts": 'import { send } from "../bilibili/http.ts";\n',
    };
    assert.deepEqual(filesHit(viaBilibiliExit), ["6 src/sites/youtube/service.ts"]);
    const typeOnly = {
      "src/sites/types.ts": "export interface SiteCtx {\n  fetch: typeof fetch;\n}\n",
      "src/sites/youtube/service.ts": 'import type { SiteCtx } from "../types.ts";\n',
    };
    assert.deepEqual(filesHit(typeOnly), []);
  });
});

describe("第 6 条：主世界里接住播放器字幕", () => {
  test("只有接住字幕的那个文件许取一次网页请求对象的原型，别处、第二处、新建、别的网络调用都拦", () => {
    const file = "src/sites/youtube/page/caption-catch.ts";
    assert.deepEqual(rulesHit(file, "const methods = scope.XMLHttpRequest.prototype;\n"), []);
    assert.deepEqual(rulesHit(file, "const a = scope.XMLHttpRequest.prototype;\nconst b = scope.XMLHttpRequest.prototype;\n"), [6]);
    assert.deepEqual(rulesHit(file, "const a = scope.XMLHttpRequest.prototype;\nconst r = new XMLHttpRequest();\n"), [6]);
    assert.deepEqual(rulesHit(file, "const a = scope.XMLHttpRequest.prototype;\nawait fetch(url);\n"), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/page/main-bridge.ts", "const methods = scope.XMLHttpRequest.prototype;\n"), [6]);
    assert.deepEqual(rulesHit("src/content/youtube-bridge.ts", "const methods = scope.XMLHttpRequest.prototype;\n"), [6]);
  });
});

describe("第 6 条：页面模块和读页面的边界", () => {
  test("各站 page/ 下的模块和 page.ts 一样：不发请求、不带入后台读取代码、只在本站里互相带入", () => {
    assert.deepEqual(rulesHit("src/sites/youtube/page/read-panel.ts", 'import { read } from "../service.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/bilibili/page/slot.ts", 'import { nav } from "../../youtube/page/nav.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/url.ts", 'import { nav } from "./page/nav.ts";\n'), [6]);
    assert.deepEqual(rulesHit("src/sites/youtube/page/nav.ts", 'node.id = "panel";\n'), [5]);
    assert.deepEqual(rulesHit("src/sites/youtube/page.ts", 'import { nav } from "./page/nav.ts";\n'), []);
    assert.deepEqual(rulesHit("src/sites/youtube/page/read-panel.ts", 'import { model } from "./panel-types.ts";\nimport { rules } from "../url.ts";\n'), []);
  });

  test("读页面的模块不操作页面，点击只在 page/commands.ts", () => {
    const actions = [
      "row.click();",
      'row["click"]();',
      "const { click } = row;",
      "row.focus();",
      "row.dispatchEvent(event);",
      'const event = new MouseEvent("click");',
      "list.scrollIntoView();",
      "list.scrollTop = 120;",
      "video.currentTime = 30;",
      "video.pause();",
    ];
    for (const line of actions) assert.deepEqual(rulesHit("src/sites/youtube/page/read-panel.ts", `${line}\n`), [6], line);
    assert.deepEqual(rulesHit("src/sites/youtube/page/read-panel.ts", "const at = video.currentTime;\nconst same = video.currentTime === 3;\n"), []);
    assert.deepEqual(rulesHit("src/sites/youtube/page/commands.ts", "button.click();\n"), []);
    assert.deepEqual(rulesHit("src/sites/youtube/page.ts", "button.click();\n"), [6]);
    assert.deepEqual(rulesHit("src/content/youtube.ts", "button.click();\n"), [6]);
  });

  test("内容脚本只导入自己站的页面模块", () => {
    assert.deepEqual(rulesHit("src/content/youtube.ts", 'import { createPanelReader } from "../sites/youtube/page/read-panel.ts";\n'), []);
    assert.deepEqual(rulesHit("src/content/bilibili.ts", 'import { createPanelReader } from "../sites/youtube/page/read-panel.ts";\n'), [1]);
    assert.deepEqual(rulesHit("src/content/youtube.ts", 'import { createYoutubeService } from "../sites/youtube/service.ts";\n'), [1]);
  });
});
