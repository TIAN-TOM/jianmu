// 构建开关的全局常量，名字和取值见 features.ts。构建用 esbuild 的 define 换成字面量，Node 测试由 tests/helpers/build-flags.ts 定义。
// 要裁的代码直接写裸常量的分支（FEATURE_X ? … : …），开关保护的内容放进只从这些分支引用的单独模块。
export {};

declare global {
  const FEATURE_FRAME_EXPLAIN: boolean;
  const FEATURE_YOUTUBE: boolean;
  const FEATURE_YOUTUBE_OPEN_PANEL: boolean;
  const FEATURE_YOUTUBE_CAPTION_CATCH: boolean;
  const FEATURE_KEEP_CONSENT: boolean;
}
