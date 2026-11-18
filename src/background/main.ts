/// <reference types="chrome" />
// 后台入口：同步注册全部顶层监听，每个都先过醒来钩子。模块加载时不碰存储、数据库和网络，
// 依赖等第一个事件来了才建。提示词构建时内联，缺文件时构建就失败。
import { respond } from "../platform/messaging.ts";
import { restrictToTrustedContexts } from "../platform/storage.ts";
import { createApp, type App } from "./app.ts";
import { chromeDeps } from "./chrome-deps.ts";
import { PROMPT_FILES } from "./prompts.ts";
import { createWake } from "./wake.ts";

let app: App | undefined;
const current = (): App => (app ??= createApp(chromeDeps(PROMPT_FILES)));
// 每个事件先看一眼扩展目录里的文件换没换（一分钟最多一次），换了就自己重新加载。
const wake = createWake(() => restrictToTrustedContexts(chrome.storage.local), console, () => current().onWake());

chrome.runtime.onMessage.addListener(
  wake((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) =>
    respond(current().dispatch(message, sender), sendResponse),
  ),
);
chrome.runtime.onConnect.addListener(wake((port: chrome.runtime.Port) => current().connect(port)));
chrome.runtime.onInstalled.addListener(wake((details: chrome.runtime.InstalledDetails) => void current().onInstalled(details.reason)));
chrome.runtime.onStartup.addListener(wake(() => void current().onStartup()));
// 站点授权有增减：要用户另外授权的站按授权注册或撤下内容脚本。构建开关关着时 App 什么都不做。
chrome.permissions.onAdded.addListener(wake(() => void current().onPermissionsChanged()));
chrome.permissions.onRemoved.addListener(wake(() => void current().onPermissionsChanged()));
chrome.tabs.onRemoved.addListener(wake((tabId: number) => current().onTabRemoved(tabId)));
// 打开就出结论看开着的视频标签页，前台的排最前：开关关着、确认启用之前，App 不读标签页地址就返回。
chrome.tabs.onActivated.addListener(wake(() => current().onTabActivated()));
chrome.tabs.onUpdated.addListener(
  wake((tabId: number, change: chrome.tabs.OnUpdatedInfo) => current().onTabUpdated(change, tabId)),
);
chrome.windows.onFocusChanged.addListener(wake((windowId: number) => current().onFocusChanged(windowId)));
chrome.storage.onChanged.addListener(
  wake((changes: Record<string, chrome.storage.StorageChange>, area: string) => void current().onStorageChanged(changes, area)),
);
