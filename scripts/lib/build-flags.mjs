// 构建开关的取值记录：构建把这次每个开关的取值写在 build/ 之外，不进包；打包时读回来核对，开着任何开关的构建不打包。
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_GLOBALS, FEATURE_NAMES, RELEASE_FEATURES, TEST_BUILD_FEATURES } from "../../src/shared/features.ts";

/** @typedef {import("../../src/shared/features.ts").FeatureSet} FeatureSet */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BUILD_FLAGS_FILE = join(ROOT, ".build-flags.json");

/**
 * 构建参数对应的开关取值，不带参数就是发行构建。带参数的都不打包。
 *   --test-build      全部打开，给页面测试用
 *   --frame-explain   只打开解释当前画面，是画面验证构建，给开发者本人在真实页面上验证截帧用
 *   --youtube-ops     只打开 YouTube 代开面板和代换语言，给开发者本人在 YouTube 上验证用
 * @type {Readonly<Record<string, FeatureSet>>}
 */
export const BUILD_VARIANTS = Object.freeze({
  "--test-build": TEST_BUILD_FEATURES,
  "--frame-explain": Object.freeze({ ...RELEASE_FEATURES, frameExplain: true }),
  "--youtube-ops": Object.freeze({ ...RELEASE_FEATURES, youtubeOpenPanel: true, youtubeSwitchLang: true }),
});

/** @param {readonly string[]} args @returns {FeatureSet} */
export function featuresFromArgs(args) {
  const chosen = Object.keys(BUILD_VARIANTS).filter((flag) => args.includes(flag));
  if (chosen.length > 1) throw new Error(`${chosen.join(" 和 ")} 只能选一个`);
  const [flag] = chosen;
  return flag === undefined ? RELEASE_FEATURES : /** @type {FeatureSet} */ (BUILD_VARIANTS[flag]);
}

/** 写进记录的形状：全局常量名到布尔值。 @param {FeatureSet} features @returns {Record<string, boolean>} */
export function buildFlagsRecord(features) {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [FEATURE_GLOBALS[name], features[name] === true]));
}

/** @param {FeatureSet} features @param {string} [file] */
export function writeBuildFlags(features, file = BUILD_FLAGS_FILE) {
  writeFileSync(file, `${JSON.stringify(buildFlagsRecord(features), null, 2)}\n`);
}

/** 构建开始前删掉旧记录：这次构建没跑完时，打包找不到记录就不出包。 @param {string} [file] */
export function clearBuildFlags(file = BUILD_FLAGS_FILE) {
  rmSync(file, { force: true });
}

/** 没有记录时是 undefined，读不成 JSON 时是 null。 @param {string} [file] @returns {unknown} */
export function readBuildFlags(file = BUILD_FLAGS_FILE) {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 这份记录能不能打包：每个开关都要有，所有值都得是 false。 @param {unknown} record @returns {string[]} */
export function buildFlagProblems(record) {
  if (record === undefined) return ["找不到这次构建的开关记录，先用 npm run build 重新构建"];
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return ["构建开关记录的形状不对，用 npm run build 重新构建"];
  }
  /** @type {Record<string, unknown>} */
  const values = { ...record };
  const problems = Object.values(FEATURE_GLOBALS)
    .filter((name) => typeof values[name] !== "boolean")
    .map((name) => `构建开关记录里没有 ${name} 的取值，用 npm run build 重新构建`);
  const on = Object.keys(values).filter((name) => values[name] !== false);
  if (on.length > 0) problems.push(`这次构建开着 ${on.join("、")}：测试构建和本机验证构建不能打包，用 npm run build 重新构建`);
  return problems;
}
