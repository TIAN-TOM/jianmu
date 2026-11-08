// 后台路由自己的错误码：发送方、启用闸门、请求形状、卡片开关、存储写满和没料到的失败；
// 另有两个由页面的消息客户端给出：请求没送到后台，送到以后等回复时断了。

export type RoutingErrorCode =
  | "FORBIDDEN"
  | "NOT_ENABLED"
  | "INVALID_REQUEST"
  | "CARD_DISABLED"
  | "STORAGE_FULL"
  | "BACKGROUND_FAILED"
  | "BACKGROUND_UNREACHABLE"
  | "BACKGROUND_DROPPED";

export const ROUTING_ERROR_TEXT: Readonly<Record<RoutingErrorCode, string>> = {
  FORBIDDEN: "这个页面不能做这件事。",
  NOT_ENABLED: "还没启用简幕，先在侧边栏或设置页点「启用简幕」。",
  INVALID_REQUEST: "请求的内容不对，没有处理。",
  CARD_DISABLED: "播放页卡片已在设置里关闭。",
  STORAGE_FULL: "浏览器给扩展的存储空间满了，没有存进去。",
  BACKGROUND_FAILED: "后台出了问题，没有完成，稍后再试。",
  BACKGROUND_UNREACHABLE:
    "扩展后台没有响应，请求没能发出去，这和视频网站的账号、模型服务的密钥和网络都无关。"
    + "请到浏览器的扩展管理页把简幕关闭再重新开启，然后再试一次，这样不会删除你的笔记和概览。"
    + "仍然不行、要卸载重装时，先在设置页用「导出备份」把笔记和概览存成文件：卸载会清空本机保存的全部笔记和概览，重装后再用「恢复备份」导入。",
  BACKGROUND_DROPPED:
    "扩展后台在处理途中断开了，没有收到结果。这次请求可能已经发给了模型，用到模型服务的操作会照常计费；"
    + "先别急着重试，稍后重新打开这个视频，看看结果有没有存下来。这和视频网站的账号、模型服务的密钥和网络都无关。",
};
