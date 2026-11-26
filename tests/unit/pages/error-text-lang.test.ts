// 报错文案的取法不传语言时是简体：页面、内容脚本和后台里取它们的地方都要把语言传进去，漏传就会在英文、繁体界面里露出简体。
// 只认直接调用；按名字导入、改了名导入的都算。后台的 aiFailure 不传语言过不了类型检查，这里不管。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { splitSource } from "../../helpers/source-scan.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = ["src/pages", "src/content", "src/background"];

/** 取报错文案的函数：从哪个模块导入，语言是第几个参数（从 1 数）。 */
const HELPERS: readonly { readonly module: RegExp; readonly name: string; readonly langArg: number }[] = [
  { module: /\/core\/errors\.ts$/, name: "describe", langArg: 3 },
  { module: /\/core\/errors\.ts$/, name: "errorCopy", langArg: 3 },
  { module: /\/shared\/ui\/state\.ts$/, name: "stateCopy", langArg: 3 },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** 字符串的内容换成空格，数参数时不被里面的逗号、括号带偏。 */
function blankStrings(code: string): string {
  return code.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, (literal) => literal[0] + " ".repeat(literal.length - 2) + literal[0]);
}

/** 从左括号起数顶层参数，返回参数个数；括号没配上时返回 -1。 */
function argCount(code: string, open: number): number {
  let depth = 0;
  let count = 0;
  let sawToken = false;
  for (let index = open; index < code.length; index++) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") {
      depth++;
      if (depth > 1) sawToken = true;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth === 0) return sawToken ? count + 1 : 0;
    } else if (char === "," && depth === 1) {
      count++;
      sawToken = false;
    } else if (depth >= 1 && !/\s/.test(char ?? "")) {
      sawToken = true;
    }
  }
  return -1;
}

/** 这个文件里每个取文案函数的本地名字：按名字导入或者 as 改了名。 */
function localNames(code: string): { readonly local: string; readonly name: string; readonly langArg: number }[] {
  const found: { local: string; name: string; langArg: number }[] = [];
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const [, specifiers = "", from = ""] = match;
    for (const specifier of specifiers.split(",")) {
      const [imported = "", local = imported] = specifier.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/);
      const helper = HELPERS.find((entry) => entry.name === imported && entry.module.test(from));
      if (helper) found.push({ local, name: helper.name, langArg: helper.langArg });
    }
  }
  return found;
}

test("页面、内容脚本和后台取报错文案时都传了语言", () => {
  const missing: string[] = [];
  let checked = 0;
  for (const dir of SCANNED) {
    for (const path of sourceFiles(join(ROOT, dir))) {
      const { code: source } = splitSource(readFileSync(path, "utf8"));
      const code = blankStrings(source);
      for (const { local, name, langArg } of localNames(source)) {
        for (const call of code.matchAll(new RegExp(String.raw`(?<![.\w$])${local}\s*\(`, "g"))) {
          const open = (call.index ?? 0) + call[0].length - 1;
          const args = argCount(code, open);
          checked++;
          if (args < langArg) {
            const line = code.slice(0, call.index).split("\n").length;
            missing.push(`${relative(ROOT, path)}:${line} ${name}（${args} 个参数）`);
          }
        }
      }
    }
  }
  assert.ok(checked > 20, `只找到 ${checked} 处调用，扫描规则可能失效了`);
  assert.deepEqual(missing, []);
});
