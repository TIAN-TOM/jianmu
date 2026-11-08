// 消息分发。顺序是：认发送方、认消息、按路由表放行发送方、核对请求形状、要手势的先打开侧边栏、
// 过启用闸门、这时才按地址认内容脚本的站点和视频、卡片开关、处理。闸门之前不读任何网页地址。
// 端口走同一套发送方核对和启用闸门；连上以后启用失效就断开，会发起工作的消息每条再查一次启用。
import { fail, type ErrorCode, type Failure, type Result } from "../core/errors.ts";
import { jsonCopy, type PortLike } from "../platform/messaging.ts";
import { isSettingsError } from "../platform/settings-store.ts";
import { isQuotaError } from "../platform/storage.ts";
import type { Api, PageName, PortEvent, PortMessage, PortName, PortNotice, RouteName, SenderKind } from "../shared/messages.ts";
import type { ContentTabs } from "./content-tabs.ts";
import { errorLabel, type Log } from "./log.ts";
import type { MessageSender, SenderCtx, Senders, SiteSenderCtx } from "./senders.ts";

/** 确认前放行的路由在类型上不能要发送方的视频：确认前不读网页地址。 */
type Gate =
  | { readonly beforeEnable: true; readonly video?: never }
  | { readonly beforeEnable?: undefined; readonly video?: "from-sender" };

export interface HandlerCtx {
  readonly sender: SenderCtx | SiteSenderCtx;
  /** 要手势的路由：分发时已经同步发起了打开侧边栏，这里是它的结果。 */
  readonly panelOpened?: Promise<boolean>;
}

export type Route<K extends RouteName> = Gate & {
  readonly senders: readonly SenderKind[];
  /** senders 含 page 时，再点名收哪些扩展页面。 */
  readonly pages?: readonly PageName[];
  /** 只查形状，不碰地址和存储。 */
  readonly validate: (req: unknown, ctx: SenderCtx) => req is Api[K]["req"];
  /** 只有幂等的请求断线时由页面自动重试。 */
  readonly idempotent?: boolean;
  /** 打开侧边栏要在用户手势还有效时同步调用，分发时先开再做别的。 */
  readonly gesture?: "open-panel";
  readonly handler: (req: Api[K]["req"], ctx: HandlerCtx) => Promise<Result<Api[K]["res"]>>;
};

export type Routes = { readonly [K in RouteName]: Route<K> };

/** 分发只看这些字段，测试可以喂造好的路由表。 */
export type AnyRoute = Gate & {
  readonly senders: readonly SenderKind[];
  readonly pages?: readonly PageName[];
  readonly validate: (req: unknown, ctx: SenderCtx) => boolean;
  readonly idempotent?: boolean;
  readonly gesture?: "open-panel";
  readonly handler: (req: never, ctx: HandlerCtx) => Promise<Result<unknown>>;
};

/** 后台这一头的端口：给页面发消息、主动断开。 */
export interface PortHandle<Out = unknown> {
  readonly id: string;
  post(message: Out): void;
  close(): void;
}

/** 连上以后怎么处理：逐条收消息（已经过了形状核对和启用重查），页面断开时收尾。 */
export interface PortSession<In = unknown> {
  readonly onMessage: (message: In) => void | Promise<void>;
  readonly onDisconnect?: () => void;
}

export interface PortSpec<P extends PortName> {
  readonly senders: readonly SenderKind[];
  readonly pages?: readonly PageName[];
  readonly beforeEnable?: true;
  /** 连上以后逐条核对形状，不碰地址和存储。 */
  readonly validate: (message: unknown, ctx: SenderCtx) => message is PortMessage<P>;
  /** 这条消息会不会发起读取或模型请求；会的每条都重查一次启用。 */
  readonly starts: (message: PortMessage<P>) => boolean;
  readonly onConnect: (port: PortHandle<PortEvent<P>>, ctx: SenderCtx) => PortSession<PortMessage<P>>;
}

export type Ports = { readonly [P in PortName]?: PortSpec<P> };

/** 分发只看这些字段，测试可以喂造好的端口。 */
export interface AnyPortSpec {
  readonly senders: readonly SenderKind[];
  readonly pages?: readonly PageName[];
  readonly beforeEnable?: true;
  readonly validate: (message: unknown, ctx: SenderCtx) => boolean;
  readonly starts: (message: never) => boolean;
  readonly onConnect: (port: PortHandle<never>, ctx: SenderCtx) => PortSession<never>;
}

export interface RouterDeps {
  readonly routes: Readonly<Record<string, AnyRoute>>;
  readonly ports: Readonly<Record<string, AnyPortSpec>>;
  readonly senders: Senders;
  /** 首次启用确认算不算数：版本和指纹都对得上才算。 */
  readonly enabled: () => Promise<boolean>;
  /** 播放页卡片的开关。 */
  readonly cardEnabled: () => Promise<boolean>;
  readonly contentTabs: ContentTabs;
  /** 同步发起打开侧边栏。 */
  readonly openPanel: (windowId: number) => Promise<boolean>;
  readonly log: Log;
}

export interface Router {
  /** 能当场拒绝的同步回，其余回 Promise；不会抛错，也不会拒绝。 */
  readonly dispatch: (message: unknown, sender: MessageSender | undefined) => Failure | Promise<Result<unknown>>;
  /** 端口连接：认不出、不在端口表里、发送方不放行的当场断开；没确认启用的回一条通知再断开。 */
  readonly connect: (port: PortLike) => void;
  /** 启用失效（比如清除全部数据）：每个业务端口发一条通知再断开。 */
  readonly closeBusinessPorts: (code: ErrorCode) => void;
}

const CONTENT_KINDS: readonly SenderKind[] = ["content:bilibili", "content:youtube"];

interface Envelope {
  readonly type: string;
  readonly req: unknown;
}

function isEnvelope(message: unknown): message is Envelope {
  return typeof message === "object" && message !== null && typeof (message as { type?: unknown }).type === "string" && "req" in message;
}

type Allowance = Pick<AnyRoute, "senders" | "pages">;

function senderAllowed(route: Allowance, ctx: SenderCtx): boolean {
  switch (ctx.kind) {
    case "panel":
    case "card":
      return route.senders.includes(ctx.kind);
    case "page":
      return route.senders.includes("page") && ctx.page !== undefined && ctx.page !== "other" && (route.pages ?? []).includes(ctx.page);
    case "content":
      return route.senders.some((kind) => CONTENT_KINDS.includes(kind));
  }
}

// 只收一个站的内容脚本时，站点要等闸门之后按地址核对。
const oneSiteOnly = (route: AnyRoute): boolean => route.senders.filter((kind) => CONTENT_KINDS.includes(kind)).length === 1;

// 浏览器在端口已经断开时发消息、断开会抛错，这时什么都不用做。
function quietly(action: () => void): void {
  try {
    action();
  } catch {
    // 页面已经走了。
  }
}

export function createRouter(deps: RouterDeps): Router {
  const { routes, ports, senders, contentTabs, log } = deps;
  /** 连上了、不是确认前放行的端口，启用失效时要断开的那些。 */
  const business = new Map<string, (code: ErrorCode) => void>();
  let portCount = 0;

  // 启用状态读不出来时按后台出错断开，不当成没确认。
  async function gate(): Promise<ErrorCode | null> {
    try {
      return (await deps.enabled()) ? null : "NOT_ENABLED";
    } catch (error) {
      log.error("端口核对启用状态失败", errorLabel(error));
      return "BACKGROUND_FAILED";
    }
  }

  function connect(port: PortLike): void {
    const ctx = senders.authenticate(port.sender as MessageSender | undefined);
    const spec = ctx && Object.hasOwn(ports, port.name) ? ports[port.name] : undefined;
    if (!ctx || !spec || !senderAllowed(spec, ctx)) {
      quietly(() => port.disconnect());
      return;
    }
    openPort(port, spec, ctx);
  }

  // 发送方和端口名都认下了：先过启用闸门，过了才交给端口的处理，之后逐条核对。
  function openPort(port: PortLike, spec: AnyPortSpec, ctx: SenderCtx): void {
    const id = `port-${(portCount += 1)}`;
    const name = port.name;
    let state: "pending" | "open" | "closed" = "pending";
    let session: PortSession<never> | undefined;
    // 消息按到达的顺序处理，连上时的启用核对排在最前；核对完之前到的消息先排着。
    let queue: Promise<void> = Promise.resolve();
    const later = (step: () => Promise<void> | void): void => {
      queue = queue.then(step).catch((error: unknown) => log.error(`端口「${name}」处理失败`, errorLabel(error)));
    };
    const end = (): void => {
      const ending = session;
      session = undefined;
      business.delete(id);
      if (ending?.onDisconnect) later(() => ending.onDisconnect?.());
    };
    const close = (code?: ErrorCode): void => {
      if (state === "closed") return;
      state = "closed";
      if (code) quietly(() => port.postMessage({ type: "port.error", code } satisfies PortNotice));
      quietly(() => port.disconnect());
      end();
    };
    const handle: PortHandle<unknown> = {
      id,
      post: (message) => {
        if (state === "open") quietly(() => port.postMessage(jsonCopy(message)));
      },
      close: () => close(),
    };

    async function receive(message: unknown): Promise<void> {
      if (state !== "open" || !session) return;
      if (!spec.validate(message, ctx)) {
        handle.post({ type: "port.error", code: "INVALID_REQUEST" } satisfies PortNotice);
        return;
      }
      if (spec.beforeEnable !== true && spec.starts(message as never)) {
        const refused = await gate();
        if (refused) return close(refused);
      }
      if (state !== "open" || !session) return;
      // 不等处理做完：一批翻译在跑时，页面发来的「停下」也要马上轮到。
      void Promise.resolve(session.onMessage(message as never)).catch((error: unknown) =>
        log.error(`端口「${name}」处理失败`, errorLabel(error)),
      );
    }

    port.onMessage.addListener((message) => {
      if (state !== "closed") later(() => receive(message));
    });
    port.onDisconnect.addListener(() => {
      if (state === "closed") return;
      state = "closed";
      end();
    });
    later(async () => {
      const refused = spec.beforeEnable === true ? null : await gate();
      if (refused) return close(refused);
      if (state !== "pending") return;
      state = "open";
      if (spec.beforeEnable !== true) business.set(id, close);
      session = spec.onConnect(handle as PortHandle<never>, ctx);
    });
  }

  function failureOf(type: string, error: unknown): Failure {
    if (isSettingsError(error)) return fail(error.code);
    if (isQuotaError(error)) return fail("STORAGE_FULL");
    log.error(`后台处理「${type}」失败`, errorLabel(error));
    return fail("BACKGROUND_FAILED");
  }

  async function finish(
    type: string,
    route: AnyRoute,
    req: unknown,
    ctx: SenderCtx,
    sender: MessageSender,
    panelOpened: Promise<boolean> | undefined,
  ): Promise<Result<unknown>> {
    try {
      if (route.beforeEnable !== true && !(await deps.enabled())) return fail("NOT_ENABLED");
      let resolved: SenderCtx | SiteSenderCtx = ctx;
      if (ctx.kind === "content" && (route.video === "from-sender" || oneSiteOnly(route))) {
        const site = senders.resolveSite(ctx, sender);
        if (!site) return fail(oneSiteOnly(route) ? "FORBIDDEN" : "INVALID_REQUEST");
        if (!route.senders.includes(`content:${site.site}`)) return fail("FORBIDDEN");
        resolved = site;
      }
      if (ctx.kind === "card" && !(await deps.cardEnabled())) return fail("CARD_DISABLED");
      return await route.handler(req as never, panelOpened ? { sender: resolved, panelOpened } : { sender: resolved });
    } catch (error) {
      return failureOf(type, error);
    }
  }

  return {
    dispatch(message, sender) {
      const ctx = senders.authenticate(sender);
      if (!ctx || !sender) return fail("FORBIDDEN");
      if (!isEnvelope(message) || !Object.hasOwn(routes, message.type)) return fail("FORBIDDEN");
      const route = routes[message.type];
      if (!route || !senderAllowed(route, ctx)) return fail("FORBIDDEN");
      // 认得出、放行了的内容脚本才登记它的标签页编号，只记编号。
      if (ctx.kind === "content" && ctx.tabId !== undefined) contentTabs.add(ctx.tabId);
      if (!route.validate(message.req, ctx)) return fail("INVALID_REQUEST");
      // 打开侧边栏前面不能有任何等待，否则浏览器认为用户手势已经过期。
      const panelOpened =
        route.gesture === "open-panel"
          ? ctx.windowId === undefined
            ? Promise.resolve(false)
            : deps.openPanel(ctx.windowId)
          : undefined;
      return finish(message.type, route, message.req, ctx, sender, panelOpened);
    },
    connect,
    closeBusinessPorts(code) {
      for (const close of [...business.values()]) close(code);
    },
  };
}
