// chrome.* 的替身：runtime、tabs、sidePanel、scripting、storage 和它们的事件，外加造发送方的几个函数。
// 消息回复过一遍 JSON、存储读写用 structuredClone，和浏览器一致；地址都是自造的，不是任何真实网站。
import type { ModelServiceFetch } from "../../src/background/ai.ts";
import type { AppDeps } from "../../src/background/app.ts";
import type { AnyPortSpec } from "../../src/background/router.ts";
import type { MessageSender } from "../../src/background/senders.ts";
import type { VideoRef } from "../../src/core/video-ref.ts";
import { createLocks } from "../../src/platform/locks.ts";
import { PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { ACTIVATION_CONFIRMED, activationStatus } from "../../src/shared/settings-schema.ts";
import type { SiteRules } from "../../src/sites/types.ts";
import { manualTimers } from "./manual-timers.ts";
import { createMemoryIndexedDb } from "./memory-idb.ts";
import { memoryStorage, type MemoryStorage } from "./memory-storage.ts";

export const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const extensionUrl = (path: string): string => `${EXTENSION_ORIGIN}/${path}`;

// 两个自造的视频站，分别顶替两站的地址规则。
export const WATCH_ORIGIN = "https://watch.example";
export const TUBE_ORIGIN = "https://tube.example";
export const SAMPLE_VIDEO_ID = "BV1Sample001";
export const watchUrl = (videoId: string = SAMPLE_VIDEO_ID): string => `${WATCH_ORIGIN}/watch/${videoId}`;
export const tubeUrl = (videoId = "tube-sample"): string => `${TUBE_ORIGIN}/v/${videoId}`;

/** 存储里的启用确认：算数的和过期的（存着旧指纹）。 */
export const CONFIRMED = { ...ACTIVATION_CONFIRMED };
export const STALE_CONFIRMATION = { activationVersion: ACTIVATION_CONFIRMED.activationVersion, activationFingerprint: "0000000000000000" };

type Listener = (...args: never[]) => unknown;

interface Event {
  readonly listeners: Listener[];
  addListener(listener: Listener): void;
}

function event(): Event {
  const listeners: Listener[] = [];
  return { listeners, addListener: (listener) => void listeners.push(listener) };
}

const copy = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

export interface FakeManifest {
  readonly options_page?: string;
  readonly content_scripts?: readonly {
    readonly matches?: readonly string[];
    readonly js?: readonly string[];
    readonly css?: readonly string[];
    readonly all_frames?: boolean;
  }[];
}

export interface FakeChromeOptions {
  readonly local?: Record<string, unknown>;
  readonly session?: Record<string, unknown>;
  readonly manifest?: FakeManifest;
  /** tabs.query 查到的已开标签页。 */
  readonly openTabs?: readonly number[];
  /** sidePanel.open 被浏览器拒绝。 */
  readonly panelOpenRefused?: boolean;
  /** 往这几个标签页注入脚本时浏览器报错。 */
  readonly injectRefused?: readonly number[];
  readonly setAccessLevel?: (options: unknown) => Promise<void>;
  /** 运行时授权过的来源，permissions.contains 按它回答。 */
  readonly grantedOrigins?: readonly string[];
  /** 模型服务的替身。不给时谁发请求都报错：没准备回复的测试里不该有模型请求。 */
  readonly fetch?: ModelServiceFetch;
  readonly prompts?: Readonly<Record<string, string>>;
  /** 换掉后台的端口表。 */
  readonly ports?: Readonly<Record<string, AnyPortSpec>>;
}

/** 一次调用，记下当时存储里的启用确认算不算数：确认之后查标签页是允许的，之前不行。 */
export interface Call<T> {
  readonly value: T;
  readonly whileConfirmed: boolean;
}

/** 一条端口连接：后台那头用 postMessage、disconnect 和两个事件，页面那头用 send、close。 */
export interface FakePort {
  readonly name: string;
  readonly sender: MessageSender;
  /** 后台发给页面的消息。 */
  readonly posted: unknown[];
  /** 后台断开了它。 */
  disconnected: boolean;
  readonly onMessage: Event;
  readonly onDisconnect: Event;
  postMessage(message: unknown): void;
  disconnect(): void;
  /** 页面发一条消息；哪一头断开以后都发不出去，回 false。 */
  send(message: unknown): boolean;
  /** 页面关掉：后台收到断开。 */
  close(): void;
}

export function createFakeChrome(options: FakeChromeOptions = {}) {
  const storageChanged = event();
  const watchArea = (area: MemoryStorage, name: "local" | "session") => {
    const changed = (before: Record<string, unknown>, keys: readonly string[]) => {
      const changes = Object.fromEntries(
        keys.map((key) => [key, { oldValue: before[key], newValue: structuredClone(area.data[key]) }]),
      );
      // 浏览器在写完之后另起一轮派发。
      setImmediate(() => {
        for (const listener of storageChanged.listeners) listener(changes as never, name as never);
      });
    };
    return {
      ...area,
      async set(entries: Record<string, unknown>) {
        const before = structuredClone(area.data);
        await area.set(entries);
        changed(before, Object.keys(entries));
      },
      async remove(key: string | readonly string[]) {
        const before = structuredClone(area.data);
        await area.remove(key);
        changed(before, typeof key === "string" ? [key] : key);
      },
    };
  };
  const localData = memoryStorage(options.local);
  const sessionData = memoryStorage(options.session);
  const confirmedNow = (): boolean => activationStatus(localData.data[SETTINGS_STORAGE_KEY]).state === "current";
  const record = <T>(list: Call<T>[], value: T): void => void list.push({ value, whileConfirmed: confirmedNow() });

  const calls = {
    accessLevels: [] as unknown[],
    storageReads: [] as { readonly area: string; readonly keys: unknown }[],
    broadcasts: [] as unknown[],
    tabMessages: [] as { readonly tabId: number; readonly message: unknown }[],
    tabQueries: [] as Call<unknown>[],
    tabGets: [] as Call<number>[],
    siteParses: [] as Call<string>[],
    panelOpens: [] as number[],
    /** 往标签页里注入的脚本和样式。 */
    injections: [] as Call<{ readonly tabId: number; readonly files: readonly string[]; readonly allFrames?: boolean }>[],
    panelBehaviors: [] as unknown[],
    optionsOpened: 0,
    /** 发给模型服务的请求地址。 */
    fetches: [] as string[],
    /** 保活调了几次扩展接口。 */
    pings: 0,
  };
  const timers = manualTimers();

  const reading = <A extends ReturnType<typeof watchArea>>(area: A, name: string): A => ({
    ...area,
    async get(keys?: string | readonly string[] | null) {
      calls.storageReads.push({ area: name, keys: structuredClone(keys) });
      return area.get(keys);
    },
  });
  const local = {
    ...reading(watchArea(localData, "local"), "local"),
    async setAccessLevel(level: unknown) {
      calls.accessLevels.push(level);
      await options.setAccessLevel?.(level);
    },
  };
  const session = reading(watchArea(sessionData, "session"), "session");

  const runtime = {
    id: EXTENSION_ID,
    getURL: extensionUrl,
    getManifest: (): FakeManifest => options.manifest ?? {},
    async openOptionsPage() {
      calls.optionsOpened += 1;
    },
    async sendMessage(message: unknown) {
      calls.broadcasts.push(copy(message));
    },
    onMessage: event(),
    onConnect: event(),
    onInstalled: event(),
    onStartup: event(),
  };
  const tabs = {
    async query(info: { url: string[] }) {
      record(calls.tabQueries, structuredClone(info));
      return (options.openTabs ?? []).map((id) => ({ id }));
    },
    async get(tabId: number) {
      record(calls.tabGets, tabId);
      return { id: tabId };
    },
    async sendMessage(tabId: number, message: unknown) {
      calls.tabMessages.push({ tabId, message: copy(message) });
    },
    onRemoved: event(),
  };
  const sidePanel = {
    open({ windowId }: { windowId: number }) {
      calls.panelOpens.push(windowId);
      return options.panelOpenRefused ? Promise.reject(new Error("需要用户手势")) : Promise.resolve();
    },
    async setPanelBehavior(behavior: unknown) {
      calls.panelBehaviors.push(behavior);
    },
  };
  const inject = async ({ target, files }: { target: { tabId: number; allFrames?: boolean }; files: string[] }) => {
    record(calls.injections, { ...target, files: [...files] });
    if ((options.injectRefused ?? []).includes(target.tabId)) throw new Error("Cannot access contents of the page");
    return [];
  };
  const scripting = { executeScript: inject, insertCSS: inject };
  const indexedDB = createMemoryIndexedDb();
  const permissions = {
    async getAll() {
      return { origins: [...(options.grantedOrigins ?? [])] };
    },
    async contains({ origins }: { origins: string[] }) {
      return origins.every((origin) => (options.grantedOrigins ?? []).includes(origin));
    },
    async remove() {
      return false;
    },
  };
  const fetch: ModelServiceFetch = async (url, init) => {
    calls.fetches.push(url);
    if (options.fetch) return options.fetch(url, init);
    throw new Error("测试里没有准备模型服务的回复");
  };
  const chrome = { runtime, tabs, sidePanel, scripting, permissions, storage: { local, session, onChanged: storageChanged } };

  // 两个自造站点的地址规则，记下每次解析，看闸门之前有没有读地址。
  const rule = (platform: VideoRef["platform"], prefix: string): SiteRules => ({
    platform,
    optionalPermission: platform === "youtube",
    parseWatchUrl(url) {
      record(calls.siteParses, url);
      if (!url.startsWith(prefix)) return null;
      const videoId = url.slice(prefix.length).split(/[?#/]/)[0] ?? "";
      return videoId ? { platform, videoId } : null;
    },
    canonicalUrl: (ref) => `${prefix}${ref.videoId}`,
  });
  const siteRules = [rule("bilibili", `${WATCH_ORIGIN}/watch/`), rule("youtube", `${TUBE_ORIGIN}/v/`)];

  /** 照浏览器的做法把消息交给后台的监听，等它回复。 */
  function send(message: unknown, sender: MessageSender): Promise<unknown> {
    return new Promise((resolve) => {
      let answered = false;
      const sendResponse = (value: unknown) => {
        answered = true;
        resolve(copy(value));
      };
      let keepOpen = false;
      for (const listener of runtime.onMessage.listeners) {
        if (listener(copy(message) as never, sender as never, sendResponse as never) === true) keepOpen = true;
      }
      if (!keepOpen && !answered) resolve(undefined);
    });
  }

  function connect(name: string, sender: MessageSender): FakePort {
    let closedByPage = false;
    const port: FakePort = {
      name,
      sender,
      posted: [],
      disconnected: false,
      onMessage: event(),
      onDisconnect: event(),
      postMessage(message) {
        if (port.disconnected || closedByPage) throw new Error("端口已经断开");
        port.posted.push(copy(message));
      },
      disconnect: () => {
        port.disconnected = true;
      },
      send(message) {
        if (port.disconnected || closedByPage) return false;
        for (const listener of port.onMessage.listeners) listener(copy(message) as never);
        return true;
      },
      close() {
        if (port.disconnected || closedByPage) return;
        closedByPage = true;
        for (const listener of port.onDisconnect.listeners) listener();
      },
    };
    for (const listener of runtime.onConnect.listeners) listener(port as never);
    return port;
  }

  const fire = (target: Event, ...args: unknown[]) => {
    for (const listener of target.listeners) listener(...(args as never[]));
  };

  return {
    chrome,
    local,
    session,
    calls,
    timers,
    siteRules,
    send,
    connect,
    confirmedNow,
    fireInstalled: (reason = "install") => fire(runtime.onInstalled, { reason }),
    /** 后台用的那份内存数据库。 */
    indexedDB,
    fireStartup: () => fire(runtime.onStartup),
    fireTabRemoved: (tabId: number) => fire(tabs.onRemoved, tabId, {}),
    fireStorageChanged: (changes: Record<string, unknown>, area: string) => fire(storageChanged, changes, area),
    /** 直接交给 createApp 的依赖。 */
    deps: (log: AppDeps["log"] = console): AppDeps => ({
      runtime,
      tabs,
      sidePanel,
      scripting,
      permissions,
      storage: { local, session },
      indexedDB: () => indexedDB,
      locks: createLocks(),
      siteRules,
      fetch,
      prompts: options.prompts ?? {},
      ping: () => {
        calls.pings += 1;
      },
      timers,
      ...(options.ports ? { ports: options.ports } : {}),
      log,
    }),
  };
}

export type FakeChrome = ReturnType<typeof createFakeChrome>;

/** 各类发送方，形状照浏览器给的。 */
export const senders = {
  panel: (): MessageSender => ({ id: EXTENSION_ID, origin: EXTENSION_ORIGIN, url: extensionUrl(PAGE_PATHS.sidepanel) }),
  /** 侧边栏页面自己占一个标签页打开。 */
  panelInTab: (tabId = 5): MessageSender => ({
    id: EXTENSION_ID,
    origin: EXTENSION_ORIGIN,
    url: extensionUrl(PAGE_PATHS.sidepanel),
    tab: { id: tabId, windowId: 1 },
    frameId: 0,
  }),
  page: (path: string, tabId = 11): MessageSender => ({
    id: EXTENSION_ID,
    origin: EXTENSION_ORIGIN,
    url: extensionUrl(path),
    tab: { id: tabId, windowId: 1 },
    frameId: 0,
  }),
  options: (tabId = 11): MessageSender => senders.page(PAGE_PATHS.options, tabId),
  triage: (tabId = 12): MessageSender => senders.page(PAGE_PATHS.triage, tabId),
  otherPage: (tabId = 13): MessageSender => senders.page("pages/unknown.html", tabId),
  /** 嵌在播放页里的卡片。 */
  card: (tabId = 21, path: string = PAGE_PATHS.card): MessageSender => ({
    id: EXTENSION_ID,
    origin: EXTENSION_ORIGIN,
    url: extensionUrl(path),
    tab: { id: tabId, windowId: 2, url: watchUrl(), pendingUrl: watchUrl() },
    frameId: 7,
  }),
  /** 视频页里的内容脚本。 */
  content: (url: string = watchUrl(), tabId = 31): MessageSender => ({
    id: EXTENSION_ID,
    origin: new URL(url).origin,
    url,
    tab: { id: tabId, windowId: 3, url, pendingUrl: url },
    frameId: 0,
  }),
  /** 别的扩展。 */
  foreign: (): MessageSender => ({
    id: "ponmlkjihgfedcbaponmlkjihgfedcba",
    origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
    url: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/pages/options.html",
  }),
  /** 扩展编号对，却既不是扩展页面也没有标签页。 */
  stray: (): MessageSender => ({ id: EXTENSION_ID, origin: WATCH_ORIGIN }),
};

/** 地址和标题都记读取的发送方：闸门之前读过哪些，用来证明确认前不读网页地址。 */
export function watchedSender(sender: MessageSender, reads: string[], confirmedNow: () => boolean): MessageSender {
  const note = (name: string) => {
    if (!confirmedNow()) reads.push(name);
  };
  const tab = sender.tab
    ? new Proxy(sender.tab, {
        get(target, key, receiver) {
          note(`tab.${String(key)}`);
          return Reflect.get(target, key, receiver);
        },
      })
    : undefined;
  return new Proxy(sender, {
    get(target, key, receiver) {
      note(`sender.${String(key)}`);
      return key === "tab" ? tab : Reflect.get(target, key, receiver);
    },
  });
}
