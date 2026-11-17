// 后台路由自己的错误码：发送方、不认识的请求、启用闸门、请求形状、卡片开关、存储写满和没料到的失败；
// 另有两个由页面的消息客户端给出：请求没送到后台，送到以后等回复时断了。
import type { ErrorCopy } from "./copy.ts";

export type RoutingErrorCode =
  | "FORBIDDEN"
  | "UNKNOWN_ROUTE"
  | "NOT_ENABLED"
  | "INVALID_REQUEST"
  | "CARD_DISABLED"
  | "STORAGE_FULL"
  | "BACKGROUND_FAILED"
  | "BACKGROUND_UNREACHABLE"
  | "BACKGROUND_DROPPED";

const NOT_ABOUT_ACCOUNTS = "这和视频网站的账号、模型服务的密钥和网络都无关。";

export const ROUTING_ERROR_TEXT: Readonly<Record<RoutingErrorCode, ErrorCopy>> = {
  FORBIDDEN: { cause: "这个页面不能做这件事。", impact: "什么都没做。" },
  UNKNOWN_ROUTE: {
    cause: "简幕的后台还是旧版本，不认识这个请求。",
    impact: "什么都没做，笔记和概览不会丢。",
    next: "重新加载简幕后再试。",
  },
  NOT_ENABLED: { cause: "还没启用简幕。", impact: "什么都没读，也没发给模型。", next: "在侧边栏或设置页点「启用简幕」。" },
  INVALID_REQUEST: { cause: "请求的内容不对。", impact: "没有处理。", next: "关掉这个页面重新打开，再试一次。" },
  CARD_DISABLED: { cause: "播放页卡片已经在设置里关掉了。", next: "要用的话，到设置页的「播放页」一节打开，或者直接用侧边栏。" },
  STORAGE_FULL: {
    cause: "浏览器给扩展的存储空间满了。",
    impact: "这次的内容没有存进去，已经存下的不受影响。",
    next: "到设置页点「清除缓存」腾出空间再试，笔记和概览会留着。",
  },
  BACKGROUND_FAILED: { cause: "简幕的后台出了问题。", impact: "这件事没有做完。", next: "稍后再试。" },
  BACKGROUND_UNREACHABLE: {
    cause: `简幕的后台没有响应，请求没发出去。${NOT_ABOUT_ACCOUNTS}`,
    impact: "没发给模型，不花额度。",
    next:
      "到浏览器的扩展管理页把简幕关掉再打开，这样不会删掉笔记和概览，然后再试一次。"
      + "还不行、要卸载重装的话，先在设置页点「导出备份」存成文件：卸载会清空这台电脑上的全部笔记和概览，重装后再用「恢复备份」导回来。",
  },
  BACKGROUND_DROPPED: {
    cause: `简幕的后台处理到一半断开了，没收到结果。${NOT_ABOUT_ACCOUNTS}`,
    impact: "请求可能已经发给了模型，用到模型的操作可能照样计费。",
    next: "先别急着重试，过一会儿重新打开这个视频，看看结果有没有存下来。",
  },
};
