/// <reference types="chrome" />
// 扩展内部消息的薄封装：回复先过一遍 JSON，和浏览器实际传过去的一样；广播没人收不算错。
import type { Broadcast } from "../shared/messages.ts";

export interface RuntimeMessaging {
  sendMessage(message: unknown): Promise<unknown>;
}

/** 页面和后台之间的长连接，只列用到的。后台自己断开时浏览器不再派发 onDisconnect。 */
export interface PortLike {
  readonly name: string;
  readonly sender?: unknown;
  readonly onMessage: { addListener(listener: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect(): void;
}

/** 过一遍 JSON：函数、undefined 字段和原型都去掉，和页面收到的一致。 */
export function jsonCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * 把分发的结果交给 sendResponse。同步得出的结果马上回，监听返回 false；
 * 要等的返回 true，让浏览器留着通道，等结果出来再回。分发自己接住了所有异常，这里不会收到拒绝。
 */
export function respond(reply: unknown, sendResponse: (value: unknown) => void): boolean {
  if (reply instanceof Promise) {
    void reply.then((value: unknown) => sendResponse(jsonCopy(value)));
    return true;
  }
  sendResponse(jsonCopy(reply));
  return false;
}

export interface Messenger {
  /** 发给所有开着的扩展页面：侧边栏、设置页、粗筛页、卡片。 */
  readonly toPages: (message: Broadcast) => Promise<void>;
  /** 按编号发给标签页里的内容脚本，不看地址。 */
  readonly toTabs: (tabIds: Iterable<number>, message: Broadcast) => Promise<void>;
}

export function createMessenger(
  runtime: RuntimeMessaging = chrome.runtime,
  send: (tabId: number, message: unknown) => Promise<void> = (tabId, message) => chrome.tabs.sendMessage(tabId, message).then(() => undefined),
): Messenger {
  return {
    // 没有扩展页面开着时浏览器报「收不到」，这是常态。
    toPages: (message) => runtime.sendMessage(jsonCopy(message)).then(
      () => undefined,
      () => undefined,
    ),
    async toTabs(tabIds, message) {
      const copy = jsonCopy(message);
      await Promise.all([...tabIds].map((tabId) => send(tabId, copy).catch(() => undefined)));
    },
  };
}
