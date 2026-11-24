// chrome.* 的替身：runtime、tabs、windows、sidePanel、scripting、storage、contextMenus 和它们的事件，外加造发送方的几个函数。
// 消息回复过一遍 JSON、存储读写用 structuredClone，和浏览器一致；地址都是自造的，不是任何真实网站。
import type { ModelServiceFetch } from "../../src/background/ai.ts";
import type { AppDeps } from "../../src/background/app.ts";
import type { AnyPortSpec } from "../../src/background/router.ts";
import type { MessageSender } from "../../src/background/senders.ts";
import type { VideoRef } from "../../src/core/video-ref.ts";
import { createLocks } from "../../src/platform/locks.ts";
import { PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { ACTIVATION_CONFIRMED, activationStatus } from "../../src/shared/settings-schema.ts";
import type { SiteCtx, SiteRules, SiteService } from "../../src/sites/types.ts";
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
  readonly options_ui?: { readonly page?: string };
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
  /** 按地址规则查时回的标签页：编号到地址。给了它，按地址查时不再回 openTabs。 */
  readonly urlTabs?: Readonly<Record<number, string>>;
  /** 按地址查标签页时照匹配规则筛 urlTabs。 */
  readonly matchUrlTabs?: boolean;
  /** sidePanel.open 被浏览器拒绝。 */
  readonly panelOpenRefused?: boolean;
  /** 老一些的浏览器：sidePanel 没有开了、关了这两个事件。 */
  readonly noPanelEvents?: boolean;
  /** 标签页里的内容脚本怎么回 tabs.sendMessage；不给时回 undefined。抛错就是送不到。 */
  readonly tabReply?: (tabId: number, message: unknown) => unknown;
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
  /** 后台用的站点读取服务。不给时哪个站都没有读取服务。 */
  readonly site?: SiteService;
  /** tabs.get 回的标题。 */
  readonly tabTitles?: Readonly<Record<number, string>>;
  /** windows.getLastFocused 回的窗口；null 是焦点不在 Chrome。不给时是 null。 */
  readonly focusedWindow?: number | null;
  /** 每个窗口的活动标签页：按 active 和 windowId 查时回它。 */
  readonly activeTabs?: Readonly<Record<number, { readonly id: number; readonly url?: string }>>;
  /** runtime.getContexts 回的扩展页面，比如已经开着的设置页。不给时一个都没有。 */
  readonly contexts?: readonly { readonly contextType: string; readonly documentUrl?: string; readonly tabId: number; readonly windowId: number }[];
}

/** 一次调用，记下当时存储里的启用确认算不算数：确认之后查标签页是允许的，之前不行。 */
export interface Call<T> {
  readonly value: T;
  readonly whileConfirmed: boolean;
}

/** 端口的页面那头：收后台发的消息和后台断开。 */
export interface PortPeer {
  onPost(message: unknown): void;
  onDisconnect(): void;
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

/** 扩展匹配规则的简化版：* 匹配任意一段，其余原样比。 */
function matchesPattern(pattern: string, url: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(url);
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
    /** 问了几次获得焦点的窗口。 */
    windowQueries: [] as Call<null>[],
    tabGets: [] as Call<number>[],
    siteParses: [] as Call<string>[],
    panelOpens: [] as number[],
    /** 往标签页里注入的脚本和样式。 */
    injections: [] as Call<{ readonly tabId: number; readonly files: readonly string[]; readonly allFrames?: boolean; readonly world?: string }>[],
    panelBehaviors: [] as unknown[],
    optionsOpened: 0,
    /** 在新标签页里打开的地址。 */
    tabsCreated: [] as string[],
    /** 改过的标签页：切到前台、换地址。 */
    tabUpdates: [] as { readonly tabId: number; readonly props: unknown }[],
    /** 改过的窗口：拿焦点。 */
    windowUpdates: [] as { readonly windowId: number; readonly props: unknown }[],
    /** 发给模型服务的请求地址。 */
    fetches: [] as string[],
    /** 保活调了几次扩展接口。 */
    pings: 0,
    /** 后台建的站点读取环境。 */
    siteCtxs: [] as SiteCtx[],
    /** 动态注册和注销内容脚本，按先后记。 */
    registrations: [] as Call<{ readonly action: "register" | "unregister"; readonly ids: readonly string[]; readonly matches?: readonly string[]; readonly js?: readonly string[] }>[],
  };
  /** 运行时授权过的来源，测试里可以中途增减。 */
  const granted = new Set(options.grantedOrigins ?? []);
  /** 动态注册着的内容脚本。 */
  const registered = new Map<string, { readonly matches: readonly string[]; readonly js: readonly string[]; readonly world?: string; readonly runAt?: string }>();
  const timers = manualTimers();
  /** 建着的右键菜单项，按建的先后：标识到标题、类型和勾选。 */
  const menuItems = new Map<string, { readonly title: string; readonly type: string; readonly contexts: readonly string[]; checked?: boolean }>();

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
    /** 照浏览器的做法，只在回调里有值。 */
    lastError: undefined as { message: string } | undefined,
    getURL: extensionUrl,
    getManifest: (): FakeManifest => options.manifest ?? {},
    async openOptionsPage() {
      calls.optionsOpened += 1;
    },
    async getContexts(filter: { contextTypes?: readonly string[] }) {
      return (options.contexts ?? []).filter(({ contextType }) => !filter.contextTypes || filter.contextTypes.includes(contextType)).map((context) => ({ ...context }));
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
    async query(info: { url?: string[]; active?: boolean; windowId?: number }) {
      record(calls.tabQueries, structuredClone(info));
      if (info.active === true) {
        const tab = info.windowId === undefined ? undefined : options.activeTabs?.[info.windowId];
        return tab ? [{ ...tab, windowId: info.windowId, active: true }] : [];
      }
      const patterns = info.url;
      // 打开 matchUrlTabs 时和浏览器一样按匹配规则筛；默认不筛，查什么都给全部 urlTabs。
      const hit = (url: string) => options.matchUrlTabs !== true || (patterns ?? []).some((pattern) => matchesPattern(pattern, url));
      if (patterns && options.urlTabs) return Object.entries(options.urlTabs).filter(([, url]) => hit(url)).map(([id, url]) => ({ id: Number(id), url }));
      return (options.openTabs ?? []).map((id) => ({ id }));
    },
    async get(tabId: number) {
      record(calls.tabGets, tabId);
      const title = options.tabTitles?.[tabId];
      return title === undefined ? { id: tabId } : { id: tabId, title };
    },
    async sendMessage(tabId: number, message: unknown) {
      calls.tabMessages.push({ tabId, message: copy(message) });
      return options.tabReply?.(tabId, message);
    },
    async create({ url }: { url: string }) {
      calls.tabsCreated.push(url);
      return { id: 1000 + calls.tabsCreated.length, url };
    },
    async update(tabId: number, props: object) {
      calls.tabUpdates.push({ tabId, props: copy(props) });
      return { id: tabId };
    },
    onRemoved: event(),
    onActivated: event(),
    onUpdated: event(),
  };
  const windows = {
    async getLastFocused() {
      record(calls.windowQueries, null);
      const focused = options.focusedWindow ?? null;
      return focused === null ? { id: 1, focused: false } : { id: focused, focused: true };
    },
    async update(windowId: number, props: object) {
      calls.windowUpdates.push({ windowId, props: copy(props) });
      return { id: windowId };
    },
    onFocusChanged: event(),
  };
  const sidePanel = {
    open({ windowId }: { windowId: number }) {
      calls.panelOpens.push(windowId);
      return options.panelOpenRefused ? Promise.reject(new Error("需要用户手势")) : Promise.resolve();
    },
    async setPanelBehavior(behavior: unknown) {
      calls.panelBehaviors.push(behavior);
    },
    ...(options.noPanelEvents ? {} : { onOpened: event(), onClosed: event() }),
  };
  const inject = async ({ target, files, world }: { target: { tabId: number; allFrames?: boolean }; files: string[]; world?: string }) => {
    record(calls.injections, { ...target, files: [...files], ...(world ? { world } : {}) });
    if ((options.injectRefused ?? []).includes(target.tabId)) throw new Error("Cannot access contents of the page");
    return [];
  };
  const scripting = {
    executeScript: inject,
    insertCSS: inject,
    async getRegisteredContentScripts(filter?: { ids?: string[] }) {
      return [...registered.keys()].filter((id) => !filter?.ids || filter.ids.includes(id)).map((id) => ({ id }));
    },
    async registerContentScripts(scripts: { id: string; matches: string[]; js: string[]; world?: string; runAt?: string }[]) {
      for (const { id, matches, js, world, runAt } of scripts) {
        if (registered.has(id)) throw new Error(`Duplicate script ID '${id}'`);
        registered.set(id, { matches: [...matches], js: [...js], ...(world ? { world } : {}), ...(runAt && runAt !== "document_idle" ? { runAt } : {}) });
        record(calls.registrations, { action: "register", ids: [id], matches: [...matches], js: [...js] });
      }
    },
    async unregisterContentScripts(filter?: { ids?: string[] }) {
      const ids = filter?.ids ?? [...registered.keys()];
      for (const id of ids) {
        if (!registered.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
        registered.delete(id);
      }
      record(calls.registrations, { action: "unregister", ids: [...ids] });
    },
  };
  const indexedDB = createMemoryIndexedDb();
  // 和清单支持的最低版本一样：三个接口都只走回调、不回 Promise，报错只在回调里读得到。标识重复时建不成，改一项不存在的标识会报错。
  const answer = (callback: (() => void) | undefined, error?: string): void => {
    setImmediate(() => {
      runtime.lastError = error ? { message: error } : undefined;
      callback?.();
      runtime.lastError = undefined;
    });
  };
  const contextMenus = {
    create(properties: { id: string; title: string; type: string; contexts: string[]; checked?: boolean }, callback?: () => void) {
      const duplicate = menuItems.has(properties.id);
      if (!duplicate) menuItems.set(properties.id, { title: properties.title, type: properties.type, contexts: [...properties.contexts], ...(properties.checked === undefined ? {} : { checked: properties.checked }) });
      answer(callback, duplicate ? `Cannot create item with duplicate id ${properties.id}` : undefined);
      return properties.id;
    },
    update(id: string, properties: { checked: boolean }, callback?: () => void): void {
      const item = menuItems.get(id);
      if (item) item.checked = properties.checked;
      answer(callback, item ? undefined : `Cannot find menu item with id ${id}`);
    },
    removeAll(callback?: () => void): void {
      menuItems.clear();
      answer(callback);
    },
    onClicked: event(),
  };
  const permissions = {
    async getAll() {
      return { origins: [...granted] };
    },
    async contains({ origins }: { origins: string[] }) {
      return origins.every((origin) => granted.has(origin));
    },
    async remove() {
      return false;
    },
    onAdded: event(),
    onRemoved: event(),
  };
  const fetch: ModelServiceFetch = async (url, init) => {
    calls.fetches.push(url);
    if (options.fetch) return options.fetch(url, init);
    throw new Error("测试里没有准备模型服务的回复");
  };
  const chrome = { runtime, tabs, windows, sidePanel, scripting, permissions, contextMenus, storage: { local, session, onChanged: storageChanged } };

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
    permissionOrigins: platform === "youtube" ? [`${TUBE_ORIGIN}/*`] : [],
    scriptMatches: platform === "youtube" ? [`${TUBE_ORIGIN}/*`] : [],
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

  /** page 给了就把后台发的消息和后台断开转给页面那头。 */
  function connect(name: string, sender: MessageSender, page?: PortPeer): FakePort {
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
        const copied = copy(message);
        port.posted.push(copied);
        // 浏览器另起一轮把消息交给页面。
        if (page) setImmediate(() => page.onPost(copy(copied)));
      },
      disconnect: () => {
        if (page && !port.disconnected && !closedByPage) setImmediate(() => page.onDisconnect());
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
    /** 建着的右键菜单项。 */
    menuItems,
    /** 用户点了右键菜单的一项。勾选项先照浏览器的做法翻转勾选，再交给后台。 */
    fireMenuClicked(id: string) {
      const item = menuItems.get(id);
      if (item?.type === "checkbox") item.checked = !item.checked;
      fire(contextMenus.onClicked, { menuItemId: id, ...(item?.type === "checkbox" ? { checked: item.checked, wasChecked: !item.checked } : {}), editable: false });
    },
    /** 动态注册着的内容脚本，编号到匹配规则和文件。 */
    registered,
    /** 用户给了或撤了一条授权（只改授权本身，后台的授权事件由测试自己调）。 */
    grant: (origin: string) => void granted.add(origin),
    revoke: (origin: string) => void granted.delete(origin),
    firePermissionsAdded: (origins: readonly string[]) => fire(permissions.onAdded, { origins: [...origins] }),
    firePermissionsRemoved: (origins: readonly string[]) => fire(permissions.onRemoved, { origins: [...origins] }),
    fireTabRemoved: (tabId: number) => fire(tabs.onRemoved, tabId, {}),
    /** 浏览器报一个窗口的侧边栏开了、关了。 */
    firePanelOpened: (windowId: number) => (sidePanel.onOpened ? fire(sidePanel.onOpened, { windowId, path: `/${PAGE_PATHS.sidepanel}` }) : undefined),
    firePanelClosed: (windowId: number) => (sidePanel.onClosed ? fire(sidePanel.onClosed, { windowId, path: `/${PAGE_PATHS.sidepanel}` }) : undefined),
    fireTabActivated: (tabId: number, windowId: number) => fire(tabs.onActivated, { tabId, windowId }),
    fireTabUpdated: (tabId: number, change: Record<string, unknown>, tab: Record<string, unknown>) => fire(tabs.onUpdated, tabId, change, tab),
    fireFocusChanged: (windowId: number) => fire(windows.onFocusChanged, windowId),
    fireStorageChanged: (changes: Record<string, unknown>, area: string) => fire(storageChanged, changes, area),
    /** 直接交给 createApp 的依赖。 */
    deps: (log: AppDeps["log"] = console): AppDeps => ({
      runtime,
      contextMenus,
      tabs,
      sidePanel,
      scripting,
      windows,
      permissions,
      storage: { local, session },
      indexedDB: () => indexedDB,
      locks: createLocks(),
      siteRules,
      sites: {
        service: (platform) => (options.site && options.site.rules.platform === platform ? options.site : undefined),
        ctx(_platform, { signal }) {
          const ctx: SiteCtx = {
            fetch: () => Promise.reject(new Error("测试里的读取环境不发请求")),
            signal,
            backoff: { admit: async () => ({ ok: true }), trip: async () => {}, clear: async () => {} },
          };
          calls.siteCtxs.push(ctx);
          return ctx;
        },
      },
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
