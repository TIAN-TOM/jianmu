// 扩展页面和内容脚本不渲染未转义的内容：字幕、模型输出、视频标题都只经 Preact 的文本节点或 textContent 上屏。
// 卡片开放给视频网站嵌入，侧边栏显示平台和模型给的文字，这道检查和严格的 CSP 一起守住它们。
// 只看源码里去掉注释以后的部分；写法再绕的由审查把关，这里拦常见的几种。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { splitSource } from "../../helpers/source-scan.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = ["src/pages", "src/content"];

const HTML_PROPERTY = String.raw`(?:inner|outer)HTML`;
const SINKS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "dangerouslySetInnerHTML", pattern: /\bdangerouslySetInnerHTML\b/ },
  // 赋值、复合赋值、JSX 属性和对象字面量里的键：Preact 会把同名属性直接写到元素上。
  { label: "写 innerHTML、outerHTML", pattern: new RegExp(String.raw`\b${HTML_PROPERTY}\b\s*(?:\+?=(?!=)|:)`) },
  { label: "按字符串键写 innerHTML、outerHTML", pattern: new RegExp(String.raw`["'\`]${HTML_PROPERTY}["'\`]\s*(?:\]\s*\+?=(?!=)|:)`) },
  { label: "反射写 innerHTML、outerHTML", pattern: new RegExp(String.raw`\b(?:Reflect\.set|Object\.defineProperty)\s*\([^)]*["'\`]${HTML_PROPERTY}["'\`]`) },
  { label: "insertAdjacentHTML", pattern: /\binsertAdjacentHTML\b/ },
  { label: "document.write", pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/ },
  { label: "createContextualFragment", pattern: /\bcreateContextualFragment\b/ },
  { label: "setHTMLUnsafe、parseHTMLUnsafe", pattern: /\b(?:setHTMLUnsafe|parseHTMLUnsafe)\b/ },
  { label: "srcdoc", pattern: /\bsrcdoc\b/i },
];

interface Source {
  readonly path: string;
  readonly text: string;
}

function sources(dir: string): Source[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(name)) return [];
    return [{ path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") }];
  });
}

/** 每处命中写成「文件：哪一种」。去掉块注释后行号会错位，所以不报行号。 */
function findUnescaped(files: readonly Source[]): string[] {
  return files.flatMap(({ path, text }) => {
    const { code } = splitSource(text);
    return code.split("\n").flatMap((line) => SINKS.filter(({ pattern }) => pattern.test(line)).map(({ label }) => `${path}：${label}`));
  });
}

const hits = (text: string, path = "src/pages/sample.tsx"): string[] => findUnescaped([{ path, text }]).map((hit) => hit.slice(path.length + 1));

test("src/pages/ 和 src/content/ 里没有渲染未转义内容的写法", () => {
  const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir)));
  assert.ok(
    files.some((file) => file.path.startsWith("src/pages/shared/ui/") && file.path.endsWith(".tsx")),
    "扫到了共用组件，目录没有扫空",
  );
  assert.deepEqual(findUnescaped(files), []);
});

test("能拦下造好的写法", () => {
  assert.deepEqual(hits("<div dangerouslySetInnerHTML={{ __html: text }} />\n"), ["dangerouslySetInnerHTML"]);
  assert.deepEqual(hits("node.innerHTML = text;\n"), ["写 innerHTML、outerHTML"]);
  assert.deepEqual(hits("node.innerHTML += text;\n"), ["写 innerHTML、outerHTML"]);
  assert.deepEqual(hits("node.outerHTML = text;\n"), ["写 innerHTML、outerHTML"]);
  assert.deepEqual(hits("<div innerHTML={text} />\n"), ["写 innerHTML、outerHTML"]);
  assert.deepEqual(hits("Object.assign(node, { innerHTML: text });\n"), ["写 innerHTML、outerHTML"]);
  assert.deepEqual(hits('node["innerHTML"] = text;\n'), ["按字符串键写 innerHTML、outerHTML"]);
  assert.deepEqual(hits('Object.assign(node, { "innerHTML": text });\n'), ["按字符串键写 innerHTML、outerHTML"]);
  assert.deepEqual(hits('Reflect.set(node, "innerHTML", text);\n'), ["反射写 innerHTML、outerHTML"]);
  assert.deepEqual(hits('node.insertAdjacentHTML("beforeend", text);\n'), ["insertAdjacentHTML"]);
  assert.deepEqual(hits("document.write(text);\n"), ["document.write"]);
  assert.deepEqual(hits("range.createContextualFragment(text);\n"), ["createContextualFragment"]);
  assert.deepEqual(hits("node.setHTMLUnsafe(text);\n"), ["setHTMLUnsafe、parseHTMLUnsafe"]);
  assert.deepEqual(hits("<iframe srcDoc={text} />\n"), ["srcdoc"]);
  assert.deepEqual(hits("frame.srcdoc = text;\n", "src/content/shared/frame.ts"), ["srcdoc"]);
});

test("文本写法和注释不算：textContent、读 innerHTML、比较、注释里提到的都放行", () => {
  assert.deepEqual(hits("node.textContent = text;\n"), []);
  assert.deepEqual(hits("<p>{text}</p>\n"), []);
  assert.deepEqual(hits("const before = node.innerHTML;\n"), []);
  assert.deepEqual(hits('if (node.innerHTML === "") skip();\n'), []);
  assert.deepEqual(hits("// 不用 innerHTML = 拼接，也不用 dangerouslySetInnerHTML\nconst a = 1;\n"), []);
  assert.deepEqual(hits("/* insertAdjacentHTML 会解析标记 */\nconst a = 1;\n"), []);
});
