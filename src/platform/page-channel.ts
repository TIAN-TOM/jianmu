/// <reference types="chrome" />
// 通往一个标签页里内容脚本的问答通道：只发给顶层框架，等它回话；中止时不再等。下面的接口只列用到的方法。

export interface TabMessaging {
  sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
}

export interface TabPageChannel {
  ask(message: unknown, signal: AbortSignal): Promise<unknown>;
}

export function createTabPageChannel(tabId: number, tabs: TabMessaging = chrome.tabs): TabPageChannel {
  return {
    ask(message, signal) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        tabs
          .sendMessage(tabId, message, { frameId: 0 })
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", onAbort));
      });
    },
  };
}
