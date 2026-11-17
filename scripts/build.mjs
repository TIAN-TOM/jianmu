// 构建：esbuild 打包入口、复制 static/、写入清单版本号。不压缩、不带 source map，方便用户和贡献者审阅发布包。
// 不带参数是发行构建，构建开关全部关着；--test-build、--youtube-ops 见 lib/build-flags.mjs，这两种都不打包。
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { featureDefines, FEATURE_GLOBALS, FEATURE_NAMES } from "../src/shared/features.ts";
import { clearBuildFlags, featuresFromArgs, writeBuildFlags } from "./lib/build-flags.mjs";

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

// 构建标识：按进包的源码、提示词、页面外壳、清单模板和依赖版本的内容算，同一份源码两次构建得到同一个，
// 后台和各页面注入同一个值。监听模式只在启动时算一次，各包各自重建时不会对不上。
const BUILD_INPUTS = ["src", "prompts", "static", "manifest.template.json", "package.json", "package-lock.json"];

/** @param {string} path */
function filesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const entries = readdirSync(path, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

function buildId() {
  const hash = createHash("sha256");
  const files = BUILD_INPUTS.flatMap((input) => filesUnder(join(ROOT, input)))
    .map((path) => relative(ROOT, path).split("\\").join("/"))
    // 点开头的文件（比如系统留下的目录记录）不进包，也不算进标识，免得同一个提交在两台机器上算出两个。
    .filter((file) => !file.split("/").some((part) => part.startsWith(".")))
    .sort();
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(join(ROOT, file))).update("\0");
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
  define: { __JIANMU_BUILD_ID__: JSON.stringify(buildId()) },
};

// 页面各打一个自包含的 ESM 包，不开代码拆分，产物清单才稳定。首帧外观脚本在页面 <head> 里同步加载，打成经典脚本。
/** @type {import("esbuild").BuildOptions[]} */
const bundles = [
  { entryPoints: ["src/background/main.ts"], outfile: "build/background.js", format: "iife" },
  { entryPoints: ["src/pages/sidepanel/main.tsx"], outfile: "build/pages/sidepanel.js", format: "esm" },
  { entryPoints: ["src/pages/options/main.tsx"], outfile: "build/pages/options.js", format: "esm" },
  { entryPoints: ["src/pages/triage/main.tsx"], outfile: "build/pages/triage.js", format: "esm" },
  { entryPoints: ["src/pages/shared/theme-boot.ts"], outfile: "build/pages/theme-boot.js", format: "iife" },
  { entryPoints: ["src/pages/card/main.tsx"], outfile: "build/pages/card.js", format: "esm" },
  { entryPoints: ["src/content/bilibili.ts"], outfile: "build/content/bilibili.js", format: "iife" },
];

/**
 * 每个包的完整选项。开关换成字面量以后，只从关着的分支引用的模块整段摇掉；不开 minifySyntax，
 * 直接写在死分支里的字面量会留在包里，所以开关保护的内容要放进单独的模块。
 * @param {import("../src/shared/features.ts").FeatureSet} features
 * @returns {import("esbuild").BuildOptions[]}
 */
export function bundleOptions(features) {
  const define = featureDefines(features);
  return bundles.map((bundle) => ({ ...shared, ...bundle, define: { ...shared.define, ...define } }));
}

function writeManifest() {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.template.json"), "utf8"));
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
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

function prepareOutput() {
  clearBuildFlags();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (existsSync(join(ROOT, "static"))) cpSync(join(ROOT, "static"), OUT, { recursive: true });
  writeManifest();
  writeLicenses();
}

/** @param {import("../src/shared/features.ts").FeatureSet} features */
function describeFeatures(features) {
  const on = FEATURE_NAMES.filter((name) => features[name]).map((name) => FEATURE_GLOBALS[name]);
  return on.length === 0 ? "发行构建" : `开着 ${on.join("、")}，不能打包`;
}

async function main() {
  const args = process.argv.slice(2);
  const features = featuresFromArgs(args);
  prepareOutput();
  if (args.includes("--watch")) {
    // 只盯打包入口；改 static/ 或清单模板要重新运行。
    for (const options of bundleOptions(features)) {
      const watcher = await context(options);
      await watcher.watch();
    }
    writeBuildFlags(features);
    console.log(`正在监听源码变化（${describeFeatures(features)}），开发者模式里加载 build/ 目录`);
  } else {
    await Promise.all(bundleOptions(features).map((options) => build(options)));
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
