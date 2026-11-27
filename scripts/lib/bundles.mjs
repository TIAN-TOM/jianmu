// 要打的包：构建脚本按它打，构建产物检查按它逐个扫。只放数据和纯函数，导入它不会触发构建。

/** @typedef {import("../../src/shared/features.ts").FeatureSet} FeatureSet */
/** @typedef {{ readonly entryPoints: readonly string[], readonly outfile: string, readonly format: "iife" | "esm" }} Bundle */

// 页面各打一个自包含的 ESM 包，不开代码拆分，产物清单才稳定。首帧外观脚本在页面 <head> 里同步加载，打成经典脚本。
/** @type {readonly Bundle[]} */
export const BUNDLES = [
  { entryPoints: ["src/background/main.ts"], outfile: "build/background.js", format: "iife" },
  { entryPoints: ["src/pages/sidepanel/main.tsx"], outfile: "build/pages/sidepanel.js", format: "esm" },
  { entryPoints: ["src/pages/options/main.tsx"], outfile: "build/pages/options.js", format: "esm" },
  { entryPoints: ["src/pages/triage/main.tsx"], outfile: "build/pages/triage.js", format: "esm" },
  { entryPoints: ["src/pages/shared/theme-boot.ts"], outfile: "build/pages/theme-boot.js", format: "iife" },
  { entryPoints: ["src/pages/card/main.tsx"], outfile: "build/pages/card.js", format: "esm" },
  { entryPoints: ["src/content/bilibili.ts"], outfile: "build/content/bilibili.js", format: "iife" },
];

// 只在开关打开时构建的入口：YouTube 的内容脚本运行时按授权动态注册，开关关着时这个文件不出现在产物里。
/** @type {Readonly<Record<string, readonly Bundle[]>>} */
export const FEATURE_BUNDLES = {
  youtube: [
    { entryPoints: ["src/content/youtube.ts"], outfile: "build/content/youtube.js", format: "iife" },
    { entryPoints: ["src/content/youtube-bridge.ts"], outfile: "build/content/youtube-bridge.js", format: "iife" },
  ],
};

/** 这组开关下要打的全部包，常驻的在前。 @param {FeatureSet} features @returns {Bundle[]} */
export function bundlesFor(features) {
  const gated = Object.entries(FEATURE_BUNDLES).flatMap(([name, list]) => (features[/** @type {keyof FeatureSet} */ (name)] === true ? list : []));
  return [...BUNDLES, ...gated];
}
