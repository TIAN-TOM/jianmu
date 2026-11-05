// 结构规则：只看源码文本，输入是文件表，测试既能扫真实的 src/，也能喂造好的违规样例。
import { posix } from "node:path";
import { splitSource } from "./source-scan.ts";

export interface SourceFile {
  readonly path: string; // 仓库相对路径，正斜杠
  readonly text: string;
}

export interface Violation {
  readonly rule: 1 | 2 | 3 | 4 | 5 | 6;
  readonly file: string;
  readonly detail: string;
}

const LAYER: Readonly<Record<string, number>> = {
  core: 0, shared: 0, platform: 1, sites: 2, background: 3, content: 3, pages: 3,
};

const MAX_LINES = 500;
const MAX_HEADER_LINES = 3;
const SITE_HOST = /(?:bilibili|youtube)\.com|youtu\.be|b23\.tv/i;
const PATH_STRING = /^\/[\w.~-]+\/[\w.~/-]*$/;
// 中文注释里路径常常紧贴文字，所以不要求前面有空白。
const PATH_IN_COMMENT = /\/[\w.~-]+\/[\w.~-]*/;
const HOST_AND_PATH = /[\w-]+\.[a-z]{2,}\/[\w.~-]+/i;
const EXTERNAL_LINK = /https?:\/\//;
// 模型服务的请求路径不属于两站，第 2 条不管这里。
const PATH_EXEMPT = /^src\/core\/ai\//;

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

function checkImport(file: string, specifier: string, typeOnly: boolean): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
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
    if (target !== "src/sites/rules.ts" && !own && !isTypes) return `内容脚本只导入自己站的 page.ts 和 rules.ts：${specifier}`;
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

function checkFile(file: SourceFile): Violation[] {
  const { path, text } = file;
  const { code, comments, strings } = splitSource(text);
  const found: Violation[] = [];
  const report = (rule: Violation["rule"], detail: string): void => {
    found.push({ rule, file: path, detail });
  };

  for (const { specifier, typeOnly } of importsOf(code)) {
    const problem = checkImport(path, specifier, typeOnly);
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

  if (path.startsWith("src/sites/bilibili/")) {
    if (!["url.ts", "page.ts", "service.ts"].includes(posix.basename(path)) || posix.dirname(path) !== "src/sites/bilibili") {
      report(6, "B 站目录只许有 url.ts、page.ts 和公开版 service.ts");
    }
    const hasAddress = strings.some((value) => PATH_STRING.test(value) || HOST_AND_PATH.test(value) || SITE_HOST.test(value));
    if (path.endsWith("/service.ts") && (/\bfetch\b|https?:\/\//.test(code) || hasAddress)) {
      report(6, "公开版 service.ts 不发请求，也不出现请求地址");
    }
  }
  if (path === "src/sites/services.ts") {
    for (const { specifier } of importsOf(code)) {
      if (specifier.startsWith("./bilibili/") && specifier !== "./bilibili/service.ts") {
        report(6, `B 站服务只经 service.ts 这一个入口取：${specifier}`);
      }
    }
  }
  return found;
}

export function findStructureViolations(files: readonly SourceFile[]): Violation[] {
  return files.flatMap(checkFile);
}
