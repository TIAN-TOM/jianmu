// 把源码切成代码、注释和字符串三部分，结构规则才不会把注释当代码、把字符串当注释；另从代码里取出顶层的函数定义，列出目录下的源码文件。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface SourceListOptions {
  /** 给了就返回相对这个目录、用 / 分隔的路径；不给返回绝对路径。 */
  readonly relativeTo?: string;
  /** 跳过 .d.ts 声明文件。 */
  readonly skipDeclarations?: boolean;
  /** 目录不存在时返回空表；不给时照常报错。 */
  readonly allowMissing?: boolean;
}

/** 递归列出目录下的 .ts、.tsx 文件，按目录项的顺序深度优先。 */
export function listSourceFiles(dir: string, options: SourceListOptions = {}): string[] {
  if (options.allowMissing && !existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path, options);
    if (!/\.tsx?$/.test(name) || (options.skipDeclarations && name.endsWith(".d.ts"))) return [];
    return [options.relativeTo === undefined ? path : relative(options.relativeTo, path).split(sep).join("/")];
  });
}

export interface Comment {
  readonly line: number; // 从 1 开始
  readonly text: string;
}

export interface SourceParts {
  readonly code: string; // 去掉注释，字符串原样保留
  readonly comments: readonly Comment[];
  readonly strings: readonly string[];
}

const REGEX_BEFORE = /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|in|of))\s*$/;

export function splitSource(text: string): SourceParts {
  const comments: Comment[] = [];
  const strings: string[] = [];
  let code = "";
  let index = 0;
  let line = 1;

  const advance = (end: number): string => {
    const chunk = text.slice(index, end);
    line += chunk.split("\n").length - 1;
    index = end;
    return chunk;
  };

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const start = line;
      const chunk = advance(end === -1 ? text.length : end);
      comments.push({ line: start, text: chunk.slice(2) });
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const start = line;
      const chunk = advance(end === -1 ? text.length : end + 2);
      comments.push({ line: start, text: chunk.slice(2, -2) });
      code += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(text, index, char);
      if (end === -1) {
        // 没闭合：多半是 JSX 文本里的撇号，当普通字符处理。
        code += advance(index + 1);
      } else {
        const chunk = advance(end + 1);
        strings.push(chunk.slice(1, -1));
        code += chunk;
      }
    } else if (char === "/" && REGEX_BEFORE.test(code.slice(-16))) {
      const end = findRegexEnd(text, index);
      code += advance(end === -1 ? index + 1 : end + 1);
    } else {
      code += advance(index + 1);
    }
  }
  return { code, comments, strings };
}

export interface Definition {
  readonly name: string;
  readonly text: string; // 去掉 export、空白压成一个空格
}

// 顶层定义从行首开始；之后缩进的行、空行和行首是收尾括号的行都算它的，到下一个从行首开始的语句为止。
const DEFINITION_START = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)|^(?:export\s+)?const\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?[<(]/;
const CONTINUES = /^(?:\s|[)\]}]|$)/;

/** 顶层的函数定义：function 名字(…) {…} 和 const 名字 = (…) => …，code 是 splitSource 去掉注释以后的代码。 */
export function topLevelDefinitions(code: string): Definition[] {
  const lines = code.split("\n");
  const found: Definition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = DEFINITION_START.exec(lines[index] ?? "");
    if (!start) continue;
    let end = index + 1;
    while (end < lines.length && CONTINUES.test(lines[end] ?? "")) end += 1;
    const text = lines.slice(index, end).join("\n").replace(/^export\s+/, "").replace(/\s+/g, " ").trim();
    if (start[1] !== undefined || text.includes("=>")) found.push({ name: start[1] ?? start[2] ?? "", text });
    index = end - 1;
  }
  return found;
}

function findStringEnd(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index;
    else if (char === "\n" && quote !== "`") return -1;
  }
  return -1;
}

function findRegexEnd(text: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") return -1;
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index;
  }
  return -1;
}
