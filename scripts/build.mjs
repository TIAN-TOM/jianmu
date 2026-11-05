// 构建：esbuild 打包入口、复制 static/、写入清单版本号。不压缩、不带 source map，商店审核读得懂。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build");

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
};

// 页面各打一个自包含的 ESM 包，不开代码拆分，产物清单才稳定。
/** @type {import("esbuild").BuildOptions[]} */
const bundles = [
  { entryPoints: ["src/background/main.ts"], outfile: "build/background.js", format: "iife" },
  { entryPoints: ["src/pages/sidepanel/main.tsx"], outfile: "build/pages/sidepanel.js", format: "esm" },
];

function writeManifest() {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.template.json"), "utf8"));
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
}

function prepareOutput() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (existsSync(join(ROOT, "static"))) cpSync(join(ROOT, "static"), OUT, { recursive: true });
  writeManifest();
}

prepareOutput();
if (process.argv.includes("--watch")) {
  // 只盯打包入口；改 static/ 或清单模板要重新运行。
  for (const bundle of bundles) {
    const watcher = await context({ ...shared, ...bundle });
    await watcher.watch();
  }
  console.log("正在监听源码变化，开发者模式里加载 build/ 目录");
} else {
  await Promise.all(bundles.map((bundle) => build({ ...shared, ...bundle })));
  console.log("构建完成：build/");
}
