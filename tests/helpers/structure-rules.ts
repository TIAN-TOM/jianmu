// 结构规则：只看源码文本，输入是文件表，测试既能扫真实的 src/，也能喂造好的违规样例。
import { posix } from "node:path";
import { splitSource, type SourceParts } from "./source-scan.ts";

export interface SourceFile {
  readonly path: string; // 仓库相对路径，正斜杠
  readonly text: string;
}

export interface Violation {
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6;
  readonly file: string;
  readonly detail: string;
}

interface Edge {
  readonly specifier: string;
  readonly target: string; // 规范化后的仓库相对路径
  readonly typeOnly: boolean;
}

interface Module extends SourceFile, SourceParts {
  readonly edges: readonly Edge[]; // 只含相对导入，含只导入类型的和重导出
  readonly sends: boolean; // 去掉放行的写法以后还有网络调用
}

const LAYER: Readonly<Record<string, number>> = {
  core: 0, shared: 0, platform: 1, sites: 2, background: 3, content: 3, pages: 3,
};

const MAX_LINES = 500;
const MAX_HEADER_LINES = 3;
const SITE_HOST = /(?:bilibili|youtube|hdslb)\.com|youtu\.be|b23\.tv/i;
const PATH_STRING = /^\/[\w.~-]+\/[\w.~/-]*$/;
// 中文注释里路径常常紧贴文字，所以不要求前面有空白。
const PATH_IN_COMMENT = /\/[\w.~-]+\/[\w.~-]*/;
const HOST_AND_PATH = /[\w-]+\.[a-z]{2,}\/[\w.~-]+/i;
const EXTERNAL_LINK = /https?:\/\//;
// 模型服务的请求路径不属于两站，第 2 条不管这里。
const PATH_EXEMPT = /^src\/core\/ai\//;

// 第 6 条：只列放行的地址，不列要防的接口，被禁的名字写进这里就等于写进公开仓库。
const BILIBILI_ADDRESSES: ReadonlySet<string> = new Set([
  "https://api.bilibili.com/x/web-interface/nav",
  "https://api.bilibili.com/x/web-interface/view",
  "https://api.bilibili.com/x/web-interface/view/conclusion/get",
  "https://api.bilibili.com/x/player/wbi/v2",
  "https://api.bilibili.com/x/v2/history/toview",
]);
// 第 3 条：注释只写用途，不写字段说明、错误码和来历。
const COMMENT_SOURCE = /接口文档|文档(?:里|示例|没|：)|社区|官方示例|实测|抓到|逆推/;
const COMMENT_FIELD = /\b[a-z]+(?:_[a-z0-9]+)+\b/;
const COMMENT_CODE = /(?<![\w.])-\d{3}\b|\b\d{5}\b/;
// 只认小写：给用户看的文案里写 Cookie 是说明，不是读取。
const COOKIE_ACCESS = /\bcookies?\b|\bcookieStore\b/;
const NETWORK_CALL = /\bfetch\b|\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/;
const IDENTITY_HEADER = /^(?:cookie|user-agent|referer|origin|sec-[\w-]+|x-[\w-]+)$/i;
// 不带引号的写法。小写的 origin 常是普通字段名，留给运行时断言。
const IDENTITY_KEY = /\b(?:[Cc]ookie|[Rr]eferer|Origin)\s*:/;
const JOINED_ADDRESS = /\$\{[^}]*\}\/[\w.~-]/;
// 第 6 条：src/sites/ 里只有这几处许写网络调用，各认一种写法；不带 g 的只放行一处。
const NETWORK_ALLOWED: Readonly<Record<string, RegExp>> = {
  "src/sites/bilibili/http.ts": /\bctx\.fetch\(/g, // B 站读取唯一的请求出口
  "src/sites/services.ts": /\bfetch: fetch\.bind\(globalThis\)/, // 把 fetch 交给读取环境
  "src/sites/types.ts": /\bfetch: typeof fetch;/, // 读取环境里 fetch 的类型
};
// 前台模块只许写播放页的地址，接口地址只在后台读取模块里。
const PAGE_ADDRESS = /^https:\/\/www\.(?:bilibili|youtube)\.com\/(?:video|watch)\b/;
const BILIBILI_READ = /^src\/sites\/bilibili\/(?!(?:url|page)\.ts$)/;
// 前台模块在内容脚本和扩展页面里跑，传递带入的只能是纯逻辑、契约、地址规则和各站的 url.ts。
const FRONT_MODULE = /^src\/sites\/(?:[^/]+\/(?:url|page)|rules|types|page-types)\.ts$/;
const FRONT_SHARED: ReadonlySet<string> = new Set(["src/sites/types.ts", "src/sites/page-types.ts", "src/sites/rules.ts"]);
const SITE_FRONT_FILE = /^src\/sites\/([^/]+)\/(?:url|page)\.ts$/;
const SITE_URL = /^src\/sites\/([^/]+)\/url\.ts$/;
const CORE_OR_SHARED = /^src\/(?:core|shared)\//;

// 只有协议头不算地址：把 http 换成 https 时要写这个字符串。
const isAddress = (value: string): boolean =>
  /https?:\/\/[\w.-]/.test(value) || PATH_STRING.test(value) || HOST_AND_PATH.test(value);

const INJECTION_LITERALS: readonly RegExp[] = [
  /\.id\s*=\s*["'`]/,
  /\.className\s*=\s*["'`]/,
  /classList\.\w+\(\s*["'`]/,
  /setAttribute\(\s*["'`](?:id|class)["'`]/,
  /setProperty\(\s*["'`]--/,
  /new\s+(?:Custom)?Event\(\s*["'`]/,
  /addEventListener\(\s*["'`][^"'`]*[-:][^"'`]*["'`]/,
];

function topDir(path: string): string {
  return path.split("/")[1] ?? "";
}

function importsOf(code: string): { specifier: string; typeOnly: boolean }[] {
  const found: { specifier: string; typeOnly: boolean }[] = [];
  for (const match of code.matchAll(/\b(import|export)\s+(type\s+)?[^"'`;]*?from\s+["']([^"']+)["']/g)) {
    found.push({ specifier: match[3] ?? "", typeOnly: Boolean(match[2]) });
  }
  for (const match of code.matchAll(/\bimport\s*(?:\(\s*)?["']([^"']+)["']/g)) {
    found.push({ specifier: match[1] ?? "", typeOnly: false });
  }
  return found;
}

function edgesOf(file: string, code: string): Edge[] {
  return importsOf(code)
    .filter(({ specifier }) => specifier.startsWith("."))
    .map(({ specifier, typeOnly }) => ({ specifier, typeOnly, target: posix.normalize(posix.join(posix.dirname(file), specifier)) }));
}

function toModule(file: SourceFile): Module {
  const parts = splitSource(file.text);
  const allowed = NETWORK_ALLOWED[file.path];
  const sends = NETWORK_CALL.test(allowed ? parts.code.replace(allowed, "") : parts.code);
  return { ...file, ...parts, edges: edgesOf(file.path, parts.code), sends };
}

function checkImport(file: string, { specifier, target, typeOnly }: Edge): string | null {
  if (file.endsWith(".ts") && target.endsWith(".tsx")) return `.ts 不能导入 .tsx：${specifier}`;
  const from = topDir(file);
  const to = topDir(target);
  const fromLayer = LAYER[from];
  const toLayer = LAYER[to];
  if (fromLayer === undefined || toLayer === undefined) return `不认识的模块目录：${target}`;
  if (from !== to && fromLayer <= toLayer && !(fromLayer === 0 && toLayer === 0)) {
    return `依赖方向不对：${from} 不能导入 ${to}（${specifier}）`;
  }
  if (to !== "sites" || from === "sites") return null;
  const isTypes = target === "src/sites/types.ts";
  if (from === "background" && !["src/sites/services.ts", "src/sites/rules.ts"].includes(target) && !isTypes) {
    return `后台只经 sites/services.ts 取适配器：${specifier}`;
  }
  if (from === "pages" && target !== "src/sites/rules.ts" && !(isTypes && typeOnly)) {
    return `扩展页面只用 sites/rules.ts：${specifier}`;
  }
  if (from === "content") {
    const site = /^src\/content\/([a-z]+)\.ts$/.exec(file)?.[1];
    const own = site !== undefined && target === `src/sites/${site}/page.ts`;
    if (target !== "src/sites/rules.ts" && target !== "src/sites/page-types.ts" && !own && !isTypes) return `内容脚本只导入自己站的 page.ts 和 rules.ts：${specifier}`;
  }
  return null;
}

function headerLines(text: string): number {
  let count = 0;
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      count += 1;
      if (line.includes("*/")) inBlock = false;
    } else if (line.startsWith("//")) {
      count += 1;
    } else if (line.startsWith("/*")) {
      count += 1;
      inBlock = !line.includes("*/");
    } else {
      break;
    }
  }
  return count;
}

function checkFile(file: Module): Violation[] {
  const { path, text, code, comments, strings, edges } = file;
  const found: Violation[] = [];
  const report = (rule: Violation["rule"], detail: string): void => {
    found.push({ rule, file: path, detail });
  };

  for (const edge of edges) {
    const problem = checkImport(path, edge);
    if (problem) report(1, problem);
  }
  if (path.startsWith("src/core/") && /\bchrome\./.test(code.replace(/"[^"\n]*"|'[^'\n]*'/g, ""))) {
    report(1, "core 里不能出现 chrome.");
  }

  if (!path.startsWith("src/sites/")) {
    if (SITE_HOST.test(text)) report(2, "两站的主机名只许出现在 src/sites/");
    if (!PATH_EXEMPT.test(path)) {
      for (const value of strings) {
        if (PATH_STRING.test(value)) report(2, `路径样式的字符串只许出现在 src/sites/：${value}`);
      }
    }
  } else {
    for (const comment of comments) {
      if (EXTERNAL_LINK.test(comment.text)) {
        report(3, `第 ${comment.line} 行的注释里有外部链接`);
      } else if (PATH_IN_COMMENT.test(comment.text) || HOST_AND_PATH.test(comment.text)) {
        report(3, `第 ${comment.line} 行的注释里有路径样式的字符串`);
      } else if (COMMENT_SOURCE.test(comment.text)) {
        report(3, `第 ${comment.line} 行的注释在讲来历，注释只写用途`);
      } else if (COMMENT_FIELD.test(comment.text) || COMMENT_CODE.test(comment.text)) {
        report(3, `第 ${comment.line} 行的注释里有字段名或错误码，注释只写用途`);
      }
    }
    if (headerLines(text) > MAX_HEADER_LINES) report(3, `文件头注释超过 ${MAX_HEADER_LINES} 行`);
  }

  const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (lines > MAX_LINES) report(4, `${lines} 行，超过 ${MAX_LINES} 行`);

  if (/^src\/content\//.test(path) || /^src\/sites\/[^/]+\/page\.ts$/.test(path)) {
    for (const pattern of INJECTION_LITERALS) {
      if (pattern.test(code)) report(5, `注入页面的标识要用 shared/names.ts 的常量：${pattern.source}`);
    }
  }
  if (path === "src/shared/names.ts") {
    const block = /export const INJECTED = \{([\s\S]*?)\} as const/.exec(code)?.[1] ?? "";
    for (const value of splitSource(block).strings) {
      if (!/^(?:--)?jianmu-/.test(value)) report(5, `注入页面的标识要以 jianmu- 开头：${value}`);
    }
  }

  if (COOKIE_ACCESS.test(code)) report(6, "代码不读 Cookie，登录状态只由浏览器随请求带上");
  if (path.startsWith("src/content/") && file.sends) report(6, "内容脚本不发请求，读平台内容走后台的读取服务");
  if (path.startsWith("src/sites/")) {
    for (const value of strings) {
      if (IDENTITY_HEADER.test(value)) report(6, `不设表明身份的请求头：${value}`);
    }
    if (IDENTITY_KEY.test(code)) report(6, "不设表明身份的请求头");
    const front = SITE_FRONT_FILE.test(path);
    if (file.sends) report(6, front ? "url.ts、page.ts 不发请求" : "站点的请求只从 bilibili/http.ts 经 ctx.fetch 发");
    for (const value of strings) {
      const bad = front
        ? (EXTERNAL_LINK.test(value) || HOST_AND_PATH.test(value)) && !PAGE_ADDRESS.test(value)
        : JOINED_ADDRESS.test(value) || (isAddress(value) && !BILIBILI_ADDRESSES.has(value));
      if (bad) report(6, front ? `url.ts、page.ts 只写播放页地址：${value}` : `请求地址要写成完整常量，并且在放行表里：${value}`);
    }
  }
  if (path === "src/sites/rules.ts") {
    for (const { specifier, target, typeOnly } of edges) {
      const allowed = SITE_URL.test(target) || (typeOnly && (target === "src/sites/types.ts" || CORE_OR_SHARED.test(target)));
      if (!allowed) report(6, `rules.ts 只从各站的 url.ts 取值、从契约取类型，重导出也一样：${specifier}`);
    }
  }
  if (path === "src/sites/services.ts") {
    for (const { specifier, target } of edges) {
      if (!target.startsWith("src/sites/")) continue; // 其余目录归第 1 条
      const site = /^src\/sites\/([^/]+)\//.exec(target)?.[1];
      if (target !== (site === undefined ? "src/sites/types.ts" : `src/sites/${site}/service.ts`)) {
        report(6, `服务注册表只从各站的 service.ts 取服务，站点根下只取 types.ts：${specifier}`);
      }
    }
  }
  return found;
}

// 从 start 沿导入走到的每个模块，记下从哪个模块走过来；valueOnly 时不走只导入类型的边，它们运行时不加载。
function reach(start: string, modules: ReadonlyMap<string, Module>, valueOnly: boolean): Map<string, string> {
  const via = new Map<string, string>();
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const from = queue[index] ?? start;
    for (const edge of modules.get(from)?.edges ?? []) {
      if ((valueOnly && edge.typeOnly) || edge.target === start || via.has(edge.target)) continue;
      via.set(edge.target, from);
      queue.push(edge.target);
    }
  }
  return via;
}

function chain(start: string, target: string, via: ReadonlyMap<string, string>): string {
  const steps = [target];
  let at = target;
  while (at !== start) {
    at = via.get(at) ?? start;
    steps.unshift(at);
  }
  return steps.map((step) => step.replace(/^src\//, "")).join(" → ");
}

function frontMayReach(owner: string, target: string): boolean {
  if (CORE_OR_SHARED.test(target) || FRONT_SHARED.has(target)) return true;
  const site = SITE_URL.exec(target)?.[1];
  const ownSite = SITE_FRONT_FILE.exec(owner)?.[1];
  return site !== undefined && (ownSite === undefined || ownSite === site);
}

// 第 6 条里要看整张导入图的部分：直接导入和经别的模块转一手的同样算。
function checkReach(file: Module, modules: ReadonlyMap<string, Module>): Violation[] {
  const { path } = file;
  const found: Violation[] = [];
  // http.ts 去掉放行的出口以后不算发请求，所以不用单独放过它。
  const sender = (via: ReadonlyMap<string, string>): string | undefined =>
    [...via.keys()].find((target) => modules.get(target)?.sends === true);
  if (FRONT_MODULE.test(path)) {
    const all = reach(path, modules, false);
    const values = reach(path, modules, true);
    const outside = [...all.keys()].find((target) => !frontMayReach(path, target));
    const sending = sender(values);
    if (outside !== undefined) {
      found.push({ rule: 6, file: path, detail: `前台模块不带入后台读取代码：${chain(path, outside, all)}` });
    } else if (sending !== undefined) {
      found.push({ rule: 6, file: path, detail: `前台模块不带入发请求的模块：${chain(path, sending, values)}` });
    }
  }
  if (BILIBILI_READ.test(path)) {
    const values = reach(path, modules, true);
    const sending = sender(values);
    if (sending !== undefined) {
      found.push({ rule: 6, file: path, detail: `B 站读取的请求只从 http.ts 发，不经别的请求封装：${chain(path, sending, values)}` });
    }
  }
  return found;
}

export function findStructureViolations(files: readonly SourceFile[]): Violation[] {
  const list = files.map(toModule);
  const modules = new Map(list.map((file) => [file.path, file]));
  return list.flatMap((file) => [...checkFile(file), ...checkReach(file, modules)]);
}
