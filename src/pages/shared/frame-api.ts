// 页面这一头解释当前画面要认的广播和幂等路由：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 api.ts 的开关分支引用。

/** 读这个标签页最近几次解释：只读，断线时可以重试。 */
export const FRAME_IDEMPOTENT_ROUTES = ["frame.recent"] as const;

/** 解释有了变化的广播：只核对标签页编号。 */
export const FRAME_BROADCAST_SHAPES = {
  "frame.changed": ({ tabId }: Readonly<Record<string, unknown>>): boolean => Number.isInteger(tabId) && Number(tabId) >= 0,
};
