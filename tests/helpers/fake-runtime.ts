// 扩展页面那一头的 chrome.runtime 替身：发给后台的请求按路由回预设的结果，或者抛浏览器的报错，每次发了什么都记下；
// 后台的广播从这里派发，发送方可以自己造；长连接的页面那一头，后台那头由测试推消息、断开。回复和消息都过一遍 JSON。
import type { PageRuntime } from "../../src/pages/shared/api.ts";
import type { PortLike } from "../../src/platform/messaging.ts";
import { EXTENSION_ID } from "./chrome.ts";

/** 浏览器在几种断线情形下的报错原文。 */
export const BROWSER_ERRORS = Object.freeze({
  unreachable: "Could not establish connection. Receiving end does not exist.",
  channelClosed:
    "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received",
  portClosed: "The message port closed before a response was received.",
  invalidated: "Extension context invalidated.",
});

/** 一次请求的回复：返回值（可以是 promise）原样回，抛错或拒绝就是浏览器报错。attempt 从 1 数。 */
export type FakeReply = (req: unknown, attempt: number) => unknown;

export interface SentRequest {
  readonly type: string;
  readonly req: unknown;
}

type Listener = Parameters<PageRuntime["onMessage"]["addListener"]>[0];

export interface FakePagePort extends PortLike {
  /** 页面发出去的消息。 */
  readonly posted: unknown[];
  /** 页面自己断开了。 */
  closedByPage: boolean;
  /** 后台发一条给页面。 */
  push(message: unknown): void;
  /** 后台断开或者没了；lastError 是浏览器这时报的错。 */
  drop(lastError?: string): void;
}

const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export interface FakeRuntimeOptions {
  /** connect 时浏览器直接抛错，比如扩展已经重新加载。 */
  readonly connectThrows?: string;
}

export function fakeRuntime(options: FakeRuntimeOptions = {}) {
  const sent: SentRequest[] = [];
  const replies = new Map<string, FakeReply>();
  const listeners = new Set<Listener>();
  const ports: FakePagePort[] = [];
  /** 页面的广播监听返回了什么：返回 true 就是替后台占着通道。 */
  const listenerResults: unknown[] = [];
  let lastError: { readonly message: string } | undefined;

  const runtime: PageRuntime = {
    id: EXTENSION_ID,
    get lastError() {
      return lastError;
    },
    sendMessage(message) {
      const envelope = copy(message) as SentRequest;
      sent.push(envelope);
      const attempt = sent.filter((item) => item.type === envelope.type).length;
      const reply = replies.get(envelope.type);
      if (!reply) return Promise.reject(new Error(`测试没给 ${envelope.type} 准备回复`));
      try {
        return Promise.resolve(reply(envelope.req, attempt)).then(copy);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    onMessage: {
      addListener: (listener) => void listeners.add(listener),
      removeListener: (listener) => void listeners.delete(listener),
    },
    connect({ name }) {
      if (options.connectThrows) throw new Error(options.connectThrows);
      const messageListeners: ((message: unknown) => void)[] = [];
      const disconnectListeners: (() => void)[] = [];
      let alive = true;
      const port: FakePagePort = {
        name,
        posted: [],
        closedByPage: false,
        onMessage: { addListener: (listener) => void messageListeners.push(listener) },
        onDisconnect: { addListener: (listener) => void disconnectListeners.push(listener) },
        postMessage(message) {
          if (!alive) throw new Error("Attempting to use a disconnected port object");
          port.posted.push(copy(message));
        },
        disconnect() {
          alive = false;
          port.closedByPage = true;
        },
        push(message) {
          if (alive) for (const listener of [...messageListeners]) listener(copy(message));
        },
        drop(error) {
          if (!alive) return;
          alive = false;
          lastError = error === undefined ? undefined : { message: error };
          for (const listener of [...disconnectListeners]) listener();
          lastError = undefined;
        },
      };
      ports.push(port);
      return port;
    },
  };

  return {
    runtime,
    sent,
    ports,
    listenerResults,
    /** 给一条路由准备回复：固定值，或者按次数决定回什么、抛什么。 */
    reply(type: string, answer: FakeReply | { readonly value: unknown }) {
      replies.set(type, typeof answer === "function" ? answer : () => answer.value);
    },
    /** 发一条广播。默认发送方是本扩展的后台。 */
    broadcast(message: unknown, sender: { readonly id?: string; readonly tab?: unknown } = { id: EXTENSION_ID }) {
      for (const listener of [...listeners]) listenerResults.push(listener(copy(message), sender));
    },
    listeners: () => listeners.size,
    attempts: (type: string) => sent.filter((item) => item.type === type).length,
  };
}
