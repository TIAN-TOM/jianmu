// 后台路由自己的错误码：发送方、启用闸门、请求形状、卡片开关、存储写满和没料到的失败。

export type RoutingErrorCode =
  | "FORBIDDEN"
  | "NOT_ENABLED"
  | "INVALID_REQUEST"
  | "CARD_DISABLED"
  | "STORAGE_FULL"
  | "BACKGROUND_FAILED";

export const ROUTING_ERROR_TEXT: Readonly<Record<RoutingErrorCode, string>> = {
  FORBIDDEN: "这个页面不能做这件事。",
  NOT_ENABLED: "还没启用简幕，先在侧边栏或设置页点「启用简幕」。",
  INVALID_REQUEST: "请求的内容不对，没有处理。",
  CARD_DISABLED: "播放页卡片已在设置里关闭。",
  STORAGE_FULL: "浏览器给扩展的存储空间满了，没有存进去。",
  BACKGROUND_FAILED: "后台出了问题，没有完成，稍后再试。",
};
