// 繁体文字只写在文件名以 -hant.ts 结尾的模块里：这些模块去掉注释以后不许有简体专用字；
// 反过来，src/ 下别的文件不许有繁体专用字，例外写在下面的放行表里，并写明原因。字表取自 OpenCC（tests/helpers/hant-chars.ts）。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { charsIn, SIMPLIFIED_ONLY, TRADITIONAL_ONLY } from "../helpers/hant-chars.ts";
import { stripComments } from "../helpers/strip-comments.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HANT_FILE = /-hant\.ts$/;

// 不是繁体模块、却要写繁体字的地方：文件和允许的字。
const ALLOWED_TRADITIONAL: Readonly<Record<string, string>> = {
  // 认 YouTube 页面上自动字幕的标注，要连繁体和日文的写法一起认。
  "src/sites/youtube/service.ts": "動產",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

const FILES = sourceFiles(join(ROOT, "src"));

test("字表认得出简繁专用字，简繁通用的字两边都不算", () => {
  for (const char of "为体简这说设钥览") assert.ok(SIMPLIFIED_ONLY.has(char), char);
  for (const char of "為體簡這說設鑰覽臺裡後準") assert.ok(TRADITIONAL_ONLY.has(char), char);
  for (const char of "台里后干只面准制系着中文") {
    assert.equal(SIMPLIFIED_ONLY.has(char), false, char);
    assert.equal(TRADITIONAL_ONLY.has(char), false, char);
  }
});

test("去注释：去掉行注释和块注释，字符串、模板串和正则里的斜杠和引号原样留着", () => {
  const source = [
    "// 头注释",
    'const a = "http://example.test/x"; // 行尾注释',
    "/* 块注释 */ const b = 'it\\'s // 不是注释';",
    "const c = `模板 ${a ? `嵌套 // 不是注释` : \"}\"} 尾巴 /* 也不是 */`;",
    "const d = /\\/\\/[a/]*/g.test(a) ? { x: 1 } : 2; /** 文档注释 */",
    "const e = 4 / 2 / 1; // 除号以后的注释",
  ].join("\n");
  const stripped = stripComments(source);
  for (const kept of ['"http://example.test/x"', "'it\\'s // 不是注释'", "`模板 ${a ? `嵌套 // 不是注释` : \"}\"} 尾巴 /* 也不是 */`", "/\\/\\/[a/]*/g", "4 / 2 / 1"]) {
    assert.ok(stripped.includes(kept), kept);
  }
  for (const gone of ["头注释", "行尾注释", "块注释", "文档注释", "除号以后的注释"]) assert.ok(!stripped.includes(gone), gone);
  assert.equal(stripped.split("\n").length, source.split("\n").length);
});

test("检查本身拦得住：繁体模块的字符串里混进简体字会被认出来，注释里的简体不算", () => {
  const scan = (source: string): string[] => charsIn(stripComments(source), SIMPLIFIED_ONLY);
  assert.deepEqual(scan('// 繁体那份的说明\nexport const A = { save: "儲存設定", hint: (n: number) => `共 ${n} 則` };'), []);
  assert.deepEqual(scan('export const A = { save: "儲存设定" };'), ["设"]);
  assert.deepEqual(scan("export const A = (n: number) => `第 ${n > 1 ? `${n} 项` : \"一\"} 個`;"), ["项"]);
});

test("src/ 下的 -hant.ts 模块去掉注释以后没有简体专用字", () => {
  const hant = FILES.filter((file) => HANT_FILE.test(file));
  assert.ok(hant.length > 0);
  const found = hant
    .map((file) => [file, charsIn(stripComments(readFileSync(join(ROOT, file), "utf8")), SIMPLIFIED_ONLY).join("")] as const)
    .filter(([, chars]) => chars);
  assert.deepEqual(found, []);
});

test("src/ 下 -hant.ts 以外的文件（连注释）没有繁体专用字，放行表里写明的除外", () => {
  const found = FILES.filter((file) => !HANT_FILE.test(file))
    .map((file) => {
      const allowed = ALLOWED_TRADITIONAL[file] ?? "";
      const chars = charsIn(readFileSync(join(ROOT, file), "utf8"), TRADITIONAL_ONLY).filter((char) => !allowed.includes(char));
      return [file, chars.join("")] as const;
    })
    .filter(([, chars]) => chars);
  assert.deepEqual(found, []);
  // 放行表里的字都还用得着，用不着了就删掉那一条。
  for (const [file, chars] of Object.entries(ALLOWED_TRADITIONAL)) {
    assert.deepEqual(charsIn(readFileSync(join(ROOT, file), "utf8"), TRADITIONAL_ONLY).sort(), [...chars].sort(), file);
  }
});

test("opencc-js 只给测试和脚本用：src/ 里没有引用", () => {
  const users = FILES.filter((file) => /["']opencc-js(?:\/[^"']*)?["']/.test(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(users, []);
});
