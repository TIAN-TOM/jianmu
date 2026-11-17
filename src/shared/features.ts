// 构建开关：每个开关在发行构建里的取值只写在这里，构建脚本、打包、发布脚本和测试都从这里读。
// 构建按这张表定义同名的全局常量（build-flags.d.ts）。要裁掉的代码只写裸常量的分支，不读这里的对象：
// esbuild 折不了对象属性，读对象的分支在发行构建里裁不掉。

/** 开关名和构建时的全局常量名，一一对应。 */
export const FEATURE_GLOBALS = Object.freeze({
  frameExplain: "FEATURE_FRAME_EXPLAIN",
  youtubeOpenPanel: "FEATURE_YOUTUBE_OPEN_PANEL",
  youtubeSwitchLang: "FEATURE_YOUTUBE_SWITCH_LANG",
} as const);

export type FeatureName = keyof typeof FEATURE_GLOBALS;
export type FeatureGlobal = (typeof FEATURE_GLOBALS)[FeatureName];
export type FeatureSet = Readonly<Record<FeatureName, boolean>>;

export const FEATURE_NAMES: readonly FeatureName[] = Object.freeze(Object.keys(FEATURE_GLOBALS) as FeatureName[]);

/** 发行构建：全部关着。哪个开关要打开，先过它自己的验证和审阅。 */
export const RELEASE_FEATURES: FeatureSet = Object.freeze({
  frameExplain: false,
  youtubeOpenPanel: false,
  youtubeSwitchLang: false,
});

/** 测试构建：全部打开，只给测试用，不打包。Node 测试里的全局常量也取这一份。 */
export const TEST_BUILD_FEATURES: FeatureSet = Object.freeze({
  frameExplain: true,
  youtubeOpenPanel: true,
  youtubeSwitchLang: true,
});

/** esbuild define 的写法：每个全局常量换成字面量。只认真正的 true，别的值都按关。 */
export function featureDefines(features: FeatureSet): Record<FeatureGlobal, "true" | "false"> {
  const defines = {} as Record<FeatureGlobal, "true" | "false">;
  for (const name of FEATURE_NAMES) defines[FEATURE_GLOBALS[name]] = features[name] === true ? "true" : "false";
  return defines;
}
