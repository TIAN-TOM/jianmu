// 浏览器里的真实依赖，交给 createApp。只在第一个事件来了以后调。
import { chromePing } from "../platform/keepalive.ts";
import { createLocks } from "../platform/locks.ts";
import { createTabPageChannel } from "../platform/page-channel.ts";
import { extensionStorage } from "../platform/storage.ts";
import { siteRules } from "../sites/rules.ts";
import { createSiteCtx, siteService } from "../sites/services.ts";
import type { PromptTable } from "./ai.ts";
import type { AppDeps } from "./app.ts";

/** 浏览器里的真实依赖。只在第一个事件来了以后调；提示词由入口交进来，构建时内联。 */
export function chromeDeps(prompts: PromptTable): AppDeps {
  return {
    runtime: chrome.runtime,
    tabs: chrome.tabs,
    sidePanel: chrome.sidePanel,
    scripting: chrome.scripting,
    windows: chrome.windows,
    permissions: chrome.permissions,
    storage: extensionStorage(),
    indexedDB: () => globalThis.indexedDB,
    locks: createLocks(),
    siteRules: Object.values(siteRules),
    // 给了标签页时带上通往它的通道：要在页面里读的站（YouTube）经它读，别的站不用。
    sites: { service: siteService, ctx: (platform, { signal, tabId }) => createSiteCtx(platform, signal, tabId === undefined ? undefined : createTabPageChannel(tabId)) },
    fetch: (url, init) => fetch(url, init),
    // 解压加载的扩展读自己包里的文件，读到的是磁盘上现在的内容。
    readOwnFile: async (path) => {
      const response = await fetch(chrome.runtime.getURL(path), { cache: "no-store" });
      return response.ok ? response.text() : null;
    },
    prompts,
    ping: chromePing,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer as number),
    },
    log: console,
  };
}
