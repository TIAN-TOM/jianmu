// 构建：esbuild 打包入口、复制 static/、写入清单版本号。不压缩、不带 source map，方便用户和贡献者审阅发布包。
// 不带参数是发行构建，开关取值见 shared/features.ts；--daily、--test-build 见 lib/build-flags.mjs，只有发行构建和 --daily 能打包。
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { BUILD_ID_FILE } from "../src/shared/build-id.ts";
import { DAILY_FEATURES, featureDefines, FEATURE_GLOBALS, FEATURE_NAMES, RELEASE_FEATURES } from "../src/shared/features.ts";
import { PAGE_PATHS } from "../src/shared/names.ts";
import { youtubeRules } from "../src/sites/youtube/url.ts";
import { buildFlagsRecord, clearBuildFlags, featuresFromArgs, writeBuildFlags } from "./lib/build-flags.mjs";
import { bundlesFor } from "./lib/bundles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build");

// 提示词按文本内联：`prompt:<文件名>` 指向 prompts/ 下的模板，缺文件构建就失败。模板按 \n 解析，去掉 \r。
/** @type {import("esbuild").Plugin} */
const promptText = {
  name: "prompt-text",
  setup(plugin) {
    plugin.onResolve({ filter: /^prompt:/ }, ({ path }) => ({ path: join(ROOT, "prompts", path.slice("prompt:".length)) }));
    plugin.onLoad({ filter: /\.md$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8").replaceAll("\r", ""),
      loader: "text",
      watchFiles: [path],
    }));
  },
};

// 构建标识：按进包的源码、提示词、页面外壳、清单模板和依赖版本的内容，加上这次构建开关的取值算，
// 同一份源码、同一组开关两次构建得到同一个，后台和各页面注入同一个值。只换开关重新构建，标识也会变，
// 页面才认得出后台是另一种构建。监听模式只在启动时算一次，各包各自重建时不会对不上。
const BUILD_INPUTS = ["src", "prompts", "static", "manifest.template.json", "package.json", "package-lock.json"];

/** @param {string} path */
function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const entries = readdirSync(path, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

/** @param {import("../src/shared/features.ts").FeatureSet} features */
export function buildId(features) {
  const hash = createHash("sha256");
  const files = BUILD_INPUTS.flatMap((input) => filesUnder(join(ROOT, input)))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    // 点开头的文件（比如系统留下的目录记录）不进包，也不算进标识，免得同一个提交在两台机器上算出两个。
    .filter((file) => !file.split("/").some((part) => part.startsWith(".")))
    .sort();
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(ROOT, file))).update("\0");
  hash.update(JSON.stringify(buildFlagsRecord(features)));
  return hash.digest("hex").slice(0, 16);
}

/** @type {import("esbuild").BuildOptions} */
const shared = {
  absWorkingDir: ROOT,
  bundle: true,
  target: "chrome116",
  charset: "utf8",
  legalComments: "inline",
  minify: false,
  sourcemap: false,
  jsx: "automatic",
  jsxImportSource: "preact",
  logLevel: "warning",
  plugins: [promptText],
};

/**
 * 每个包的完整选项。开关换成字面量以后，只从关着的分支引用的模块整段摇掉；不开 minifySyntax，
 * 直接写在死分支里的字面量会留在包里，所以开关保护的内容要放进单独的模块。
 * @param {import("../src/shared/features.ts").FeatureSet} features
 * @returns {import("esbuild").BuildOptions[]}
 */
export function bundleOptions(features) {
  const define = { __JIANMU_BUILD_ID__: JSON.stringify(buildId(features)), ...featureDefines(features) };
  return bundlesFor(features).map((bundle) => ({ ...shared, ...bundle, entryPoints: [...bundle.entryPoints], define }));
}

/**
 * 产物清单：模板写上版本号。打开 YouTube 的构建里，卡片页也开放给 YouTube 的页面；发行构建照模板，只对 B 站。
 * @param {Record<string, any>} template @param {string} version @param {import("../src/shared/features.ts").FeatureSet} features
 * @returns {Record<string, any>}
 */
export function manifestFor(template, version, features) {
  const manifest = { ...template, version };
  if (!features.youtube) return manifest;
  /** @param {{ resources: string[], matches: string[] }} entry */
  const widen = (entry) => (entry.resources.includes(PAGE_PATHS.card) ? { ...entry, matches: [...entry.matches, ...youtubeRules.scriptMatches] } : entry);
  return { ...manifest, web_accessible_resources: (template.web_accessible_resources ?? []).map(widen) };
}

/** @param {import("../src/shared/features.ts").FeatureSet} features */
function writeManifest(features) {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const template = JSON.parse(readFileSync(join(ROOT, "manifest.template.json"), "utf8"));
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifestFor(template, version, features), null, 2)}\n`);
}

// 打进包的依赖：它们的许可证要随包提供，换依赖时这里跟着改。
const BUNDLED_PACKAGES = ["preact", "@preact/signals", "@preact/signals-core"];

function writeLicenses() {
  const sections = [
    readFileSync(join(ROOT, "LICENSE"), "utf8"),
    ...BUNDLED_PACKAGES.map((name) => `${name}\n\n${readFileSync(join(ROOT, "node_modules", name, "LICENSE"), "utf8")}`),
  ];
  writeFileSync(join(OUT, "LICENSE.txt"), sections.map((text) => text.trim().replaceAll("\r\n", "\n")).join("\n\n---\n\n") + "\n");
}

// 后台醒来时读这份文件，和编进去的标识比：对不上就是文件换成了别的构建，自己重新加载。
/** @param {import("../src/shared/features.ts").FeatureSet} features */
function writeBuildIdFile(features) {
  writeFileSync(join(OUT, BUILD_ID_FILE), `${buildId(features)}\n`);
}

/** @param {import("../src/shared/features.ts").FeatureSet} features */
function prepareOutput(features) {
  clearBuildFlags();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (existsSync(join(ROOT, "static"))) cpSync(join(ROOT, "static"), OUT, { recursive: true });
  writeManifest(features);
  writeLicenses();
}

/** @param {import("../src/shared/features.ts").FeatureSet} features */
function describeFeatures(features) {
  const differs = FEATURE_NAMES.filter((name) => features[name] !== RELEASE_FEATURES[name]);
  if (differs.length === 0) return "发行构建";
  if (FEATURE_NAMES.every((name) => features[name] === DAILY_FEATURES[name])) return "日用构建，用 npm run package:daily 打包";
  const on = differs.filter((name) => features[name]).map((name) => FEATURE_GLOBALS[name]);
  const off = differs.filter((name) => !features[name]).map((name) => FEATURE_GLOBALS[name]);
  return [on.length ? `多开着 ${on.join("、")}` : "", off.length ? `关着 ${off.join("、")}` : "", "不能打包"].filter(Boolean).join("，");
}

async function main() {
  const args = process.argv.slice(2);
  const features = featuresFromArgs(args);
  prepareOutput(features);
  if (args.includes("--watch")) {
    // 只盯打包入口；改 static/ 或清单模板要重新运行。
    for (const options of bundleOptions(features)) {
      const watcher = await context(options);
      await watcher.watch();
    }
    writeBuildIdFile(features);
    writeBuildFlags(features);
    console.log(`正在监听源码变化（${describeFeatures(features)}），开发者模式里加载 build/ 目录`);
  } else {
    await Promise.all(bundleOptions(features).map((options) => build(options)));
    writeBuildIdFile(features);
    // 构建完才写记录：没跑完的构建没有记录，打包不认。
    writeBuildFlags(features);
    console.log(`构建完成：build/（${describeFeatures(features)}）`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
