// 打包：从 build/ 打 dist/jianmu-<版本>.zip 和同名的 .sha256，打之前逐项校验，校验不过就不出包。
// 同一份代码打两次得到同一个 zip：文件时间和权限固定，顺序固定，zip 里不记属主和扩展时间。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checksumLine, resolveSourceDateEpoch, sortZipEntries } from "./lib/zip-order.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const ALLOWED_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".png", ".txt"]);
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".txt"]);
const FORBIDDEN_CODE = [
  [/\beval\(/, "eval("],
  [/\bnew Function\b/, "new Function"],
  [/\bimportScripts\(\s*["'`]https?:/, "远程脚本地址"],
  [/\bimport\(\s*["'`]https?:/, "远程脚本地址"],
  [/<script[^>]+src=["']https?:/, "远程脚本地址"],
  // 只认小写：给用户看的文案里写 Cookie 是说明，不是读取。
  [/\bcookies?\b|\bcookieStore\b/, "读 Cookie 的代码"],
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
 * @param {{ files: readonly string[], read: (file: string) => string, expectedFiles: readonly string[], version: string }} input
 * @returns {string[]}
 */
export function findPackageProblems({ files, read, expectedFiles, version }) {
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
  return problems;
}

/** @param {string} dir @param {string} [base] @returns {string[]} */
export function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path).split(sep).join("/")];
  });
}

/** 每个文件的修改时间设成同一个时刻，权限设成 644。 @param {string} dir @param {readonly string[]} files @param {number} epoch */
export function normalizeEntries(dir, files, epoch) {
  for (const file of files) {
    const path = join(dir, ...file.split("/"));
    chmodSync(path, 0o644);
    utimesSync(path, epoch, epoch);
  }
}

/**
 * 按字节序把文件交给 zip，写同名的 .sha256，返回校验值。zip 按本地时区记时间，所以固定成 UTC。
 * @param {{ dir: string, files: readonly string[], output: string }} input
 */
export function writeZip({ dir, files, output }) {
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  rmSync(`${output}.sha256`, { force: true });
  execFileSync("zip", ["-X", "-D", "-q", "-@", output], {
    cwd: dir,
    input: `${sortZipEntries(files).join("\n")}\n`,
    env: { ...process.env, TZ: "UTC" },
  });
  const sha256 = createHash("sha256").update(readFileSync(output)).digest("hex");
  writeFileSync(`${output}.sha256`, checksumLine(sha256, basename(output)));
  return sha256;
}

/**
 * 校验一个目录，过了就打包。发布脚本打只改版本号的测试包也走这里。
 * @param {{ dir: string, version: string, expectedFiles: readonly string[], output: string, epoch: number }} input
 * @returns {{ sha256: string, files: string[] }}
 */
export function packageDirectory({ dir, version, expectedFiles, output, epoch }) {
  const files = listFiles(dir);
  const problems = findPackageProblems({ files, read: (file) => readFileSync(join(dir, file), "utf8"), expectedFiles, version });
  if (problems.length > 0) {
    throw new Error(`打包校验没过，共 ${problems.length} 项：\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  }
  normalizeEntries(dir, files, epoch);
  return { sha256: writeZip({ dir, files, output }), files };
}

export function readExpectedFiles() {
  return readFileSync(join(ROOT, "tests/fixtures/package-files.txt"), "utf8").split("\n").filter(Boolean);
}

/** 没给 SOURCE_DATE_EPOCH 时用 HEAD 的提交时间。 */
export function sourceDateEpoch() {
  return resolveSourceDateEpoch(process.env.SOURCE_DATE_EPOCH, () => {
    try {
      return execFileSync("git", ["log", "-1", "--format=%ct", "HEAD"], { cwd: ROOT, encoding: "utf8" });
    } catch {
      throw new Error("读不到提交时间：不在 git 仓库里打包时，用 SOURCE_DATE_EPOCH 指定文件时间（秒）");
    }
  });
}

function main() {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const output = join(ROOT, "dist", `jianmu-${version}.zip`);
  try {
    const { sha256 } = packageDirectory({ dir: BUILD, version, expectedFiles: readExpectedFiles(), output, epoch: sourceDateEpoch() });
    console.log(`打包完成：${relative(ROOT, output)}\nSHA-256：${sha256}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
