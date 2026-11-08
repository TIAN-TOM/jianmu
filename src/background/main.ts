/// <reference types="chrome" />
// 后台入口：同步注册全部顶层监听，每个都先过醒来钩子。模块加载时不碰存储、数据库和网络，
// 依赖等第一个事件来了才建。提示词构建时内联，缺文件时构建就失败。
import { respond } from "../platform/messaging.ts";
import { restrictToTrustedContexts } from "../platform/storage.ts";
import { chromeDeps, createApp, type App } from "./app.ts";
import { PROMPT_FILES } from "./prompts.ts";
import { createWake } from "./wake.ts";

let app: App | undefined;
const current = (): App => (app ??= createApp(chromeDeps(PROMPT_FILES)));
const wake = createWake(() => restrictToTrustedContexts(chrome.storage.local), console);

chrome.runtime.onMessage.addListener(
  wake((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (value: unknown) => void) =>
    respond(current().dispatch(message, sender), sendResponse),
  ),
);
chrome.runtime.onConnect.addListener(wake((port: chrome.runtime.Port) => current().connect(port)));
chrome.runtime.onInstalled.addListener(wake((details: chrome.runtime.InstalledDetails) => void current().onInstalled(details.reason)));
chrome.runtime.onStartup.addListener(wake(() => void current().onStartup()));
chrome.tabs.onRemoved.addListener(wake((tabId: number) => current().onTabRemoved(tabId)));
chrome.storage.onChanged.addListener(
  wake((changes: Record<string, chrome.storage.StorageChange>, area: string) => void current().onStorageChanged(changes, area)),
);
