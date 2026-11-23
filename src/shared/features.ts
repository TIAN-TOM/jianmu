// 构建开关：每个开关在发行构建里的取值只写在这里，构建脚本、打包、发布脚本和测试都从这里读。
// 构建按这张表定义同名的全局常量（build-flags.d.ts）。要裁掉的代码只写裸常量的分支，不读这里的对象：
// esbuild 折不了对象属性，读对象的分支在发行构建里裁不掉。

/** 开关名和构建时的全局常量名，一一对应。 */
export const FEATURE_GLOBALS = Object.freeze({
  frameExplain: "FEATURE_FRAME_EXPLAIN",
  youtube: "FEATURE_YOUTUBE",
  youtubeOpenPanel: "FEATURE_YOUTUBE_OPEN_PANEL",
  youtubeCaptionCatch: "FEATURE_YOUTUBE_CAPTION_CATCH",
  keepConsent: "FEATURE_KEEP_CONSENT",
} as const);

export type FeatureName = keyof typeof FEATURE_GLOBALS;
export type FeatureGlobal = (typeof FEATURE_GLOBALS)[FeatureName];
export type FeatureSet = Readonly<Record<FeatureName, boolean>>;

export const FEATURE_NAMES: readonly FeatureName[] = Object.freeze(Object.keys(FEATURE_GLOBALS) as FeatureName[]);

/**
 * 发行构建。哪个开关要打开，先过它自己的验证和审阅。解释当前画面开发者本人 2026-11-19 定：首发带上。
 * YouTube 和点「读取字幕」时替用户点开文字稿面板，开发者本人 2026-11-19 起在日用包里用，2026-11-20 定：发行构建直接打开，
 * 最终候选包上按实机清单核对。keepConsent 只给日用包，发行包守着重新确认、重新同意。
 * youtubeCaptionCatch（页面上没有文字稿时读播放器取回的字幕）开发者本人 2026-11-23 定：先只在日用包里用几天，再定进不进首发。
 */
export const RELEASE_FEATURES: FeatureSet = Object.freeze({
  frameExplain: true,
  youtube: true,
  youtubeOpenPanel: true,
  youtubeCaptionCatch: false,
  keepConsent: false,
});

/**
 * 日用构建：开发者本人每天用的包，发行构建加上只给他自己用、或者还在日常使用里验证的开关。`npm run package:daily` 打它，
 * 文件名带 -daily，发布脚本不认；对外的发行包仍按上面那份。比发行多开 keepConsent：说明的条目变了，
 * 确认过、同意过的照旧沿用，不拦着重新确认（开发者本人 2026-11-19 定，只给他自己的日用包）；
 * 另开 youtubeCaptionCatch，在日常使用里验证（开发者本人 2026-11-23 定）。
 */
export const DAILY_FEATURES: FeatureSet = Object.freeze({ ...RELEASE_FEATURES, keepConsent: true, youtubeCaptionCatch: true });

/**
 * 测试构建：只给测试用，不打包。Node 测试里的全局常量也取这一份。功能开关全部打开；
 * keepConsent 关着，和对外的发行包一样守着重新确认、重新同意，沿用同意的那一支另有测试按日用取值跑。
 */
export const TEST_BUILD_FEATURES: FeatureSet = Object.freeze({
  frameExplain: true,
  youtube: true,
  youtubeOpenPanel: true,
  youtubeCaptionCatch: true,
  keepConsent: false,
});

/**
 * 只在开关打开时才构建、才进包的文件，相对产物根目录。发行包的文件清单是 tests/fixtures/package-files.txt，
 * 发行构建打开的开关带的文件已经写在那份清单里；别的包比发行多开的开关，打包时在清单上再加这里列的文件。
 */
export const FEATURE_FILES: Readonly<Partial<Record<FeatureName, readonly string[]>>> = Object.freeze({
  youtube: Object.freeze(["content/youtube.js", "content/youtube-bridge.js"]),
});

/** 这组开关下要进包的额外文件。 */
export function featureFiles(features: FeatureSet): readonly string[] {
  return FEATURE_NAMES.flatMap((name) => (features[name] === true ? (FEATURE_FILES[name] ?? []) : []));
}

/** esbuild define 的写法：每个全局常量换成字面量。只认真正的 true，别的值都按关。 */
export function featureDefines(features: FeatureSet): Record<FeatureGlobal, "true" | "false"> {
  const defines = {} as Record<FeatureGlobal, "true" | "false">;
  for (const name of FEATURE_NAMES) defines[FEATURE_GLOBALS[name]] = features[name] === true ? "true" : "false";
  return defines;
}
