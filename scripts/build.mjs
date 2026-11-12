// 构建：esbuild 打包入口、复制 static/、写入清单版本号。不压缩、不带 source map，方便用户和贡献者审阅发布包。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";

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

// 页面各打一个自包含的 ESM 包，不开代码拆分，产物清单才稳定。首帧外观脚本在页面 <head> 里同步加载，打成经典脚本。
/** @type {import("esbuild").BuildOptions[]} */
const bundles = [
  { entryPoints: ["src/background/main.ts"], outfile: "build/background.js", format: "iife" },
  { entryPoints: ["src/pages/sidepanel/main.tsx"], outfile: "build/pages/sidepanel.js", format: "esm" },
  { entryPoints: ["src/pages/options/main.tsx"], outfile: "build/pages/options.js", format: "esm" },
  { entryPoints: ["src/pages/shared/theme-boot.ts"], outfile: "build/pages/theme-boot.js", format: "iife" },
];

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
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  if (existsSync(join(ROOT, "static"))) cpSync(join(ROOT, "static"), OUT, { recursive: true });
  writeManifest();
  writeLicenses();
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
