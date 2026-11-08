/// <reference types="chrome" />
// 扩展页面的消息客户端：给后台发请求、收后台的广播、开长连接。请求一律回结果，不抛错。
// 后台回的拒绝原样交出去；请求没送到后台、送到以后等回复时断了，各换成一个码，不把浏览器的英文报错给用户看。
import { fail, isErrorCode, type ErrorCode } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PortLike } from "../../platform/messaging.ts";
import type { Api, Broadcast, BroadcastType, PortEvent, PortMessage, PortName, Reply, RouteName } from "../../shared/messages.ts";

/**
 * 断线时自动重试一次的路由，和后台路由表里标了幂等的一一对应，测试逐条核对。
 * 别的请求断了不重发：后台可能已经执行过，重发会多花一次模型费用、多存一条记录。
 */
export const IDEMPOTENT_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>([
  "activation.get",
  "appearance.get",
  "config.check",
  "session.get",
  "task.list",
  "transcript.get",
  "video.checkAvailable",
]);

/** 重试前等一会儿，给刚被唤醒的后台注册监听的时间。 */
export const RETRY_DELAY_MS = 200;

// 浏览器的报错文字。前一组是消息根本没送到后台（后台正在醒、或者这个页面已经和扩展断了）；
// 后一组是送到以后、等回复时通道断了，后台可能已经在做。
const UNREACHABLE = ["Could not establish connection", "Receiving end does not exist", "Extension context invalidated"];
const DROPPED = ["message port closed", "message channel closed"];

type Trouble = "unreachable" | "dropped" | "other";

const TROUBLE_CODE: Readonly<Record<Trouble, ErrorCode>> = {
  unreachable: "BACKGROUND_UNREACHABLE",
  dropped: "BACKGROUND_DROPPED",
  other: "BACKGROUND_FAILED",
};

function troubleOf(error: unknown): Trouble {
  const text = error instanceof Error ? error.message : String(error);
  if (UNREACHABLE.some((pattern) => text.includes(pattern))) return "unreachable";
  if (DROPPED.some((pattern) => text.includes(pattern))) return "dropped";
  return "other";
}

/** 后台的回复要是统一的结果形状；拒绝带着认得的码就原样交出去，别的都算后台出了问题。 */
function asReply<K extends RouteName>(raw: unknown): Reply<K> {
  if (typeof raw === "object" && raw !== null) {
    const reply = raw as { readonly ok?: unknown; readonly code?: unknown };
    if (reply.ok === true) return raw as Reply<K>;
    if (reply.ok === false && isErrorCode(reply.code)) return raw as Reply<K>;
  }
  return fail("BACKGROUND_FAILED");
}

// ---- 广播 ----

export type BroadcastOf<T extends BroadcastType> = Extract<Broadcast, { readonly type: T }>;

/** 每种广播能按什么过滤。清除、外观、启用这几种不带这些，总是送到。 */
export type BroadcastFilter<T extends BroadcastType> = T extends "task.changed" | "overview.preview"
  ? { readonly taskId?: string; readonly video?: VideoKey }
  : T extends "overview.updated" | "notes.changed"
    ? { readonly video?: VideoKey }
    : T extends "session.changed" | "panel.follow"
      ? { readonly tabId?: number }
      : Readonly<Record<string, never>>;

interface BroadcastKeys {
  readonly taskId?: string;
  readonly video?: VideoKey;
  readonly tabId?: number;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isTabId = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;

// 只核对过滤和收件方要用的字段：缺了它们的广播一律不收，免得被当成发给所有视频的。
const BROADCAST_SHAPES: Readonly<Record<BroadcastType, (message: Readonly<Record<string, unknown>>) => boolean>> = {
  "task.changed": ({ task }) => isRecord(task) && isText(task.id) && isText(task.video),
  "overview.preview": ({ video, taskId, analysis }) => isText(video) && isText(taskId) && isRecord(analysis),
  "overview.updated": ({ video, verdictPending }) => isText(video) && typeof verdictPending === "boolean",
  "notes.changed": ({ video }) => video === undefined || isText(video),
  "session.changed": ({ tabId, session }) => isTabId(tabId) && isRecord(session),
  "data.cleared": ({ scope }) => scope === "cache" || scope === "all",
  "panel.follow": ({ tabId }) => isTabId(tabId),
  "appearance.changed": ({ accentTheme, inPageCard }) => isText(accentTheme) && typeof inPageCard === "boolean",
  "activation.changed": ({ confirmed }) => typeof confirmed === "boolean",
};

function isBroadcast(message: unknown): message is Broadcast {
  if (!isRecord(message) || typeof message.type !== "string" || !Object.hasOwn(BROADCAST_SHAPES, message.type)) return false;
  return BROADCAST_SHAPES[message.type as BroadcastType](message);
}

function keysOf(message: Broadcast): BroadcastKeys {
  switch (message.type) {
    case "task.changed":
      return { taskId: message.task.id, video: message.task.video };
    case "overview.preview":
      return { taskId: message.taskId, video: message.video };
    case "overview.updated":
      return { video: message.video };
    // 不带视频的是所有视频的笔记都变了（导入、清除），按视频订阅的也要收到。
    case "notes.changed":
      return message.video === undefined ? {} : { video: message.video };
    case "session.changed":
    case "panel.follow":
      return { tabId: message.tabId };
    default:
      return {};
  }
}

function passes(filter: BroadcastKeys, message: Broadcast): boolean {
  const keys = keysOf(message);
  if (filter.taskId !== undefined && keys.taskId !== filter.taskId) return false;
  if (filter.video !== undefined && "video" in keys && keys.video !== filter.video) return false;
  if (filter.tabId !== undefined && keys.tabId !== filter.tabId) return false;
  return true;
}

// ---- 长连接 ----

export interface PortHandlers<P extends PortName> {
  /** 后台发来的消息；后台拒收某一条时收到一条 port.error。 */
  readonly onEvent: (event: PortEvent<P>) => void;
  /**
   * 后台断开、后台没了，或者一开始就没连上时调一次；页面自己 close() 时不调。
   * 断开前后台刚说过原因的，带那个码，否则按中途断开。
   */
  readonly onClose?: (code: ErrorCode) => void;
}

export interface PagePort<P extends PortName> {
  /** 发一条；已经断开时发不出去，回 false。 */
  post(message: PortMessage<P>): boolean;
  close(): void;
  readonly isOpen: () => boolean;
}

// ---- 客户端 ----

type RuntimeListener = (message: unknown, sender: { readonly id?: string; readonly tab?: unknown } | undefined) => void;

/** 页面这一头用到的 chrome.runtime。 */
export interface PageRuntime {
  readonly id: string;
  readonly lastError?: unknown;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: { addListener(listener: RuntimeListener): void; removeListener(listener: RuntimeListener): void };
  connect(info: { readonly name: string }): PortLike;
}

export interface PageApiDeps {
  readonly runtime?: PageRuntime;
  /** 重试前的等待，测试注入。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 广播的订阅方自己出的错：报出来，不挡别的订阅方。 */
  readonly reportError?: (error: unknown) => void;
}

export interface PageApi {
  /** 发一条请求。第一次在调用当下同步发出，保住用户手势（打开侧边栏要用）。 */
  send<K extends RouteName>(type: K, req: Api[K]["req"]): Promise<Reply<K>>;
  /** 订阅一种广播，回退订函数。只收后台发的、形状对的，再按过滤条件筛。 */
  on<T extends BroadcastType>(type: T, listener: (message: BroadcastOf<T>) => void, filter?: BroadcastFilter<T>): () => void;
  connect<P extends PortName>(name: P, handlers: PortHandlers<P>): PagePort<P>;
  /** 页面要走了：撤掉广播监听，关掉还开着的长连接。 */
  stop(): void;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// 页面里有 reportError，报到控制台和页面的错误事件，和没接住的错误一样。
const realReportError = (error: unknown): void => {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else console.error(error);
};

export function createPageApi({ runtime = chrome.runtime, sleep = realSleep, reportError = realReportError }: PageApiDeps = {}): PageApi {
  type Subscriber = { readonly type: BroadcastType; readonly listener: (message: Broadcast) => void; readonly filter: BroadcastKeys };
  const subscribers = new Set<Subscriber>();
  const ports = new Set<() => void>();
  let listening = false;

  // 别的扩展页面发给后台的请求也会送到这里，不是广播就不理；一律不回复，不替后台占着通道。
  const onRuntimeMessage: RuntimeListener = (message, sender) => {
    if (sender?.id !== runtime.id || sender.tab !== undefined || !isBroadcast(message)) return;
    for (const subscriber of [...subscribers]) {
      if (subscriber.type !== message.type || !subscribers.has(subscriber) || !passes(subscriber.filter, message)) continue;
      try {
        subscriber.listener(message);
      } catch (error) {
        reportError(error);
      }
    }
  };

  const listen = (): void => {
    if (listening) return;
    listening = true;
    runtime.onMessage.addListener(onRuntimeMessage);
  };

  async function send<K extends RouteName>(type: K, req: Api[K]["req"]): Promise<Reply<K>> {
    const attempts = IDEMPOTENT_ROUTES.has(type) ? 2 : 1;
    let trouble: Trouble = "other";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return asReply<K>(await runtime.sendMessage({ type, req }));
      } catch (error) {
        trouble = troubleOf(error);
        if (trouble === "other" || attempt === attempts) break;
        await sleep(RETRY_DELAY_MS);
      }
    }
    return fail(TROUBLE_CODE[trouble]);
  }

  function connect<P extends PortName>(name: P, handlers: PortHandlers<P>): PagePort<P> {
    let open = true;
    let reason: ErrorCode | null = null;
    const finish = (code: ErrorCode): void => {
      if (!open) return;
      open = false;
      ports.delete(closeQuietly);
      handlers.onClose?.(code);
    };
    let port: PortLike | null = null;
    const closeQuietly = (): void => {
      if (!open) return;
      open = false;
      ports.delete(closeQuietly);
      try {
        port?.disconnect();
      } catch {
        // 已经断了。
      }
    };
    try {
      port = runtime.connect({ name });
    } catch {
      queueMicrotask(() => finish("BACKGROUND_UNREACHABLE"));
      return { post: () => false, close: () => void (open = false), isOpen: () => open };
    }
    ports.add(closeQuietly);
    port.onMessage.addListener((message) => {
      if (!open || !isRecord(message)) return;
      if (message.type === "port.error") {
        reason = isErrorCode(message.code) ? message.code : "BACKGROUND_FAILED";
        handlers.onEvent({ type: "port.error", code: reason } as PortEvent<P>);
        return;
      }
      reason = null;
      handlers.onEvent(message as PortEvent<P>);
    });
    port.onDisconnect.addListener(() => {
      // 读一下，浏览器就不会在控制台里报没处理的错误。
      void runtime.lastError;
      finish(reason ?? "BACKGROUND_DROPPED");
    });
    return {
      post(message) {
        if (!open || !port) return false;
        try {
          reason = null;
          port.postMessage(message);
          return true;
        } catch {
          finish("BACKGROUND_DROPPED");
          return false;
        }
      },
      close: closeQuietly,
      isOpen: () => open,
    };
  }

  return {
    send,
    on(type, listener, filter) {
      const subscriber: Subscriber = { type, listener: listener as (message: Broadcast) => void, filter: (filter ?? {}) as BroadcastKeys };
      subscribers.add(subscriber);
      listen();
      return () => void subscribers.delete(subscriber);
    },
    connect,
    stop() {
      subscribers.clear();
      if (listening) runtime.onMessage.removeListener(onRuntimeMessage);
      listening = false;
      for (const close of [...ports]) close();
    },
  };
}
