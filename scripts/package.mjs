// 打包：从 build/ 打 dist/jianmu-<版本>.zip，打之前逐项校验，校验不过就不出包。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const ALLOWED_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".png"]);
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json"]);
const FORBIDDEN_CODE = [
  [/\beval\(/, "eval("],
  [/\bnew Function\b/, "new Function"],
  [/\bimportScripts\(\s*["'`]https?:/, "远程脚本地址"],
  [/\bimport\(\s*["'`]https?:/, "远程脚本地址"],
  [/<script[^>]+src=["']https?:/, "远程脚本地址"],
];

/** @param {Record<string, any>} manifest @returns {string[]} */
function manifestReferences(manifest) {
  return [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...(manifest.content_scripts ?? []).flatMap((/** @type {any} */ entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
    ...(manifest.web_accessible_resources ?? []).flatMap((/** @type {any} */ entry) => entry.resources ?? []),
  ].filter(Boolean);
}

/** 页面引用的脚本和样式，相对页面所在目录解析。 @param {string} file @param {string} html */
function pageReferences(file, html) {
  const references = [];
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) {
    const target = match[1] ?? "";
    if (/^[a-z]+:/i.test(target) || target.startsWith("//")) continue;
    references.push(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(file), target));
  }
  return references;
}

/**
 * 纯校验，方便测试。
 * @param {{ files: readonly string[], read: (file: string) => string, expectedFiles: readonly string[], version: string, storeListing?: string }} input
 * @returns {string[]}
 */
export function findPackageProblems({ files, read, expectedFiles, version, storeListing }) {
  const problems = [];
  const present = new Set(files);
  for (const file of files) {
    const name = posix.basename(file);
    const extension = posix.extname(file);
    if (!ALLOWED_EXTENSIONS.has(extension)) problems.push(`${file}：后缀不在白名单里`);
    if (name.startsWith(".")) problems.push(`${file}：点开头的文件不进包`);
    if (/\.test\.|(^|\/)tests?\//.test(file)) problems.push(`${file}：测试文件不进包`);
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const text = read(file);
    if (text.includes("\r")) problems.push(`${file}：含 CRLF`);
    for (const [pattern, label] of FORBIDDEN_CODE) {
      if (/** @type {RegExp} */ (pattern).test(text)) problems.push(`${file}：含 ${label}`);
    }
    if (extension === ".html") {
      for (const reference of pageReferences(file, text)) {
        if (!present.has(reference)) problems.push(`${file} 引用的 ${reference} 不在包里`);
      }
    }
  }
  if (!present.has("manifest.json")) {
    problems.push("manifest.json 不在包的顶层");
  } else {
    const manifest = JSON.parse(read("manifest.json"));
    if (manifest.version !== version) problems.push(`清单版本 ${manifest.version} 和 ${version} 不一致`);
    for (const reference of manifestReferences(manifest)) {
      if (!present.has(reference)) problems.push(`清单引用的 ${reference} 不在包里`);
    }
  }
  const expected = [...expectedFiles].sort().join("\n");
  const actual = [...files].sort().join("\n");
  if (expected !== actual) problems.push(`文件清单和 tests/fixtures/package-files.txt 不一致：\n${actual}`);
  if (storeListing !== undefined && !storeListing.includes(`jianmu-${version}.zip`)) {
    problems.push(`STORE-LISTING.md 里没有 jianmu-${version}.zip`);
  }
  return problems;
}

/** @param {string} dir @returns {string[]} */
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [relative(BUILD, path).split(sep).join("/")];
  });
}

function main() {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const expectedFiles = readFileSync(join(ROOT, "tests/fixtures/package-files.txt"), "utf8").split("\n").filter(Boolean);
  const listingPath = join(ROOT, "STORE-LISTING.md");
  const problems = findPackageProblems({
    files: listFiles(BUILD),
    read: (file) => readFileSync(join(BUILD, file), "utf8"),
    expectedFiles,
    version,
    ...(existsSync(listingPath) ? { storeListing: readFileSync(listingPath, "utf8") } : {}),
  });
  if (problems.length > 0) {
    console.error(`打包校验没过，共 ${problems.length} 项：`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const output = join(ROOT, "dist", `jianmu-${version}.zip`);
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  execFileSync("zip", ["-X", "-D", "-q", "-r", output, "."], { cwd: BUILD });
  console.log(`打包完成：${relative(ROOT, output)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
