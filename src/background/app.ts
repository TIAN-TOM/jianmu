/// <reference types="chrome" />
// 后台的依赖在这里拼起来。第一个事件来了才建，建的时候也不碰存储、数据库和网络。
// 按领域拆装配函数，这里只汇总；服务还没接上的事件什么都不做。
import { createClearGuard, type ClearGuard } from "../core/clear-guard.ts";
import type { IdbFactory } from "../platform/idb.ts";
import { chromePing, createKeepAlive } from "../platform/keepalive.ts";
import { createMessenger, type Messenger, type PortLike, type RuntimeMessaging } from "../platform/messaging.ts";
import { createLocks, type Locks } from "../platform/locks.ts";
import { createPermissions, type PermissionsApi } from "../platform/permissions.ts";
import { createSettingsStore, type SettingsStore } from "../platform/settings-store.ts";
import { extensionStorage, type ExtensionStorage } from "../platform/storage.ts";
import { createTabs, type Tabs, type TabsDeps } from "../platform/tabs.ts";
import { siteRules } from "../sites/rules.ts";
import type { SiteRules } from "../sites/types.ts";
import { createAiWiring, type AiWiring, type ModelServiceFetch, type PromptTable } from "./ai.ts";
import { createContentTabs, type ContentTabs } from "./content-tabs.ts";
import { createGrants, siteOriginsFromSettings, type Grants } from "./grants.ts";
import { createCardLimits, createPlaybackLimits, type CardLimits, type PlaybackLimits } from "./limits.ts";
import { errorLabel, type Log } from "./log.ts";
import { createReinject, type Reinject } from "./reinject.ts";
import { createRouter, type AnyPortSpec, type Router } from "./router.ts";
import { activationLost } from "./routes/activation.ts";
import { appearanceChange, type StorageChange } from "./routes/appearance.ts";
import { createPorts, createRoutes } from "./routes/index.ts";
import { createSenders } from "./senders.ts";
import { createSessions, type Sessions } from "./sessions.ts";
import { createChannelStore, type ChannelRecord, type ChannelStore } from "./stores/channels.ts";
import { lazyDriver } from "./stores/drivers.ts";
import { CLAIM_MS, createTaskRunner, type TaskRunner, type Timers } from "./tasks.ts";

export interface AppDeps {
  readonly runtime: RuntimeMessaging & TabsDeps["runtime"] & { readonly id: string; getURL(path: string): string };
  readonly tabs: TabsDeps["tabs"];
  readonly sidePanel: TabsDeps["sidePanel"];
  readonly scripting: TabsDeps["scripting"];
  readonly permissions: PermissionsApi;
  readonly storage: ExtensionStorage;
  /** 数据库。用到仓储时才取，没有时那次读写报错。 */
  readonly indexedDB: () => IdbFactory | undefined;
  readonly locks: Locks;
  readonly siteRules: readonly SiteRules[];
  /** 发模型请求、拉模型列表用。 */
  readonly fetch: ModelServiceFetch;
  readonly prompts: PromptTable;
  /** 任务在跑时隔一会儿调一次的扩展接口，撑着 service worker 不被回收。 */
  readonly ping: () => unknown;
  readonly timers: Timers;
  /** 端口表，默认用路由表旁边的那份；测试接上造好的端口。 */
  readonly ports?: Readonly<Record<string, AnyPortSpec>>;
  readonly log: Log;
}

export interface App {
  readonly dispatch: Router["dispatch"];
  readonly connect: (port: PortLike) => void;
  /** 安装、更新、浏览器升级等都会来，reason 是浏览器给的原因。 */
  readonly onInstalled: (reason?: string) => Promise<void>;
  readonly onStartup: () => Promise<void>;
  readonly onTabRemoved: (tabId: number) => void;
  readonly onStorageChanged: (changes: Readonly<Record<string, StorageChange>>, area: string) => Promise<void>;
}

/** 浏览器里的真实依赖。只在第一个事件来了以后调；提示词由入口交进来，构建时内联。 */
export function chromeDeps(prompts: PromptTable): AppDeps {
  return {
    runtime: chrome.runtime,
    tabs: chrome.tabs,
    sidePanel: chrome.sidePanel,
    scripting: chrome.scripting,
    permissions: chrome.permissions,
    storage: extensionStorage(),
    indexedDB: () => globalThis.indexedDB,
    locks: createLocks(),
    siteRules: Object.values(siteRules),
    fetch: (url, init) => fetch(url, init),
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

interface Core {
  readonly settings: SettingsStore;
  /** 清除本机数据和各处本机写入之间的闸门，全后台一份。 */
  readonly clearGuard: ClearGuard;
  readonly ai: AiWiring;
  /** 任务表，只在内存里。 */
  readonly tasks: TaskRunner;
  readonly cardLimits: CardLimits;
  readonly tabs: Tabs;
  readonly messenger: Messenger;
  readonly contentTabs: ContentTabs;
  /** 确认启用之后要通知的内容脚本：发过消息登记的编号，加上按清单匹配规则查到的已开标签页。 */
  readonly contentTargets: () => Promise<readonly number[]>;
  /** 往已开的视频页补注入内容脚本，启用确认不算数时什么都不做。 */
  readonly reinject: Reinject;
  readonly grants: Grants;
  readonly channels: ChannelStore;
  /** 观看会话。拿不到任务和模型入口。 */
  readonly sessions: Sessions;
  readonly playbackLimits: PlaybackLimits;
}

function assembleAi(deps: AppDeps, settings: SettingsStore, clearGuard: ClearGuard): AiWiring {
  return createAiWiring({
    settings,
    storage: deps.storage,
    permissions: createPermissions(deps.permissions, () => deps.runtime.getManifest()),
    fetch: deps.fetch,
    clearGuard,
    prompts: deps.prompts,
  });
}

function assembleTasks(deps: AppDeps, ai: AiWiring, messenger: Messenger): TaskRunner {
  const { timers } = deps;
  const keepAlive = createKeepAlive({
    ping: deps.ping,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: (timer) => timers.clearTimeout(timer),
  });
  return createTaskRunner({
    ai,
    keepAlive,
    timers,
    broadcast: (message) => void messenger.toPages(message),
    newId: () => crypto.randomUUID(),
  });
}

// 授权回收只碰授权接口：读不含密钥的设置，站点来源按设置推。
function assembleGrants(deps: AppDeps, settings: SettingsStore): Grants {
  return createGrants({
    permissions: createPermissions(deps.permissions, () => deps.runtime.getManifest()),
    loadSettings: settings.loadPublic,
    siteOrigins: siteOriginsFromSettings,
    logError: (message, detail) => deps.log.error(message, errorLabel(detail)),
  });
}

function assembleSessions(deps: AppDeps, clearGuard: ClearGuard, messenger: Messenger) {
  const channels = createChannelStore({
    driver: lazyDriver<ChannelRecord>("channels", deps.indexedDB),
    guard: clearGuard,
    now: deps.timers.now,
  });
  const sessions = createSessions({
    storage: deps.storage.session,
    channels,
    guard: clearGuard,
    now: deps.timers.now,
    broadcast: (message) => void messenger.toPages(message),
    log: deps.log,
  });
  return { channels, sessions, playbackLimits: createPlaybackLimits({ now: deps.timers.now }) };
}

function assembleCore(deps: AppDeps): Core {
  const tabs = createTabs({ tabs: deps.tabs, sidePanel: deps.sidePanel, runtime: deps.runtime, scripting: deps.scripting });
  const contentTabs = createContentTabs();
  const settings = createSettingsStore({ storage: deps.storage, locks: deps.locks });
  const clearGuard = createClearGuard();
  const ai = assembleAi(deps, settings, clearGuard);
  const messenger = createMessenger(deps.runtime, tabs.send);
  const enabled = async () => (await settings.activation()).state === "current";
  return {
    settings,
    clearGuard,
    ai,
    tasks: assembleTasks(deps, ai, messenger),
    // 令牌和认领时限一样长：过了这个时间，没人认领的任务已经收掉了。
    cardLimits: createCardLimits({ now: deps.timers.now, newToken: () => crypto.randomUUID(), tokenTtlMs: CLAIM_MS }),
    tabs,
    messenger,
    contentTabs,
    // 通知是尽力而为：查不到标签页时只发给登记过的，不让确认启用这类写入跟着报错。
    contentTargets: async () => [...new Set([...contentTabs.list(), ...(await tabs.contentScriptTabs().catch(() => []))])],
    reinject: createReinject({ tabs, enabled, log: deps.log }),
    grants: assembleGrants(deps, settings),
    ...assembleSessions(deps, clearGuard, messenger),
  };
}

function assembleRouter(deps: AppDeps, core: Core): Router {
  const { settings, tabs, contentTabs } = core;
  return createRouter({
    routes: createRoutes(core),
    ports: deps.ports ?? createPorts(),
    senders: createSenders({ extensionId: deps.runtime.id, extensionUrl: (path) => deps.runtime.getURL(path), rules: deps.siteRules }),
    enabled: async () => (await settings.activation()).state === "current",
    async cardEnabled() {
      try {
        return (await settings.loadPublic()).inPageCard;
      } catch {
        return false;
      }
    },
    contentTabs,
    openPanel: tabs.openSidePanel,
    log: deps.log,
  });
}

export function createApp(deps: AppDeps): App {
  const core = assembleCore(deps);
  const router = assembleRouter(deps, core);
  // 安装、更新和浏览器启动都设一次：这是持久的设置，不必每次醒来都设。安装时不打开设置页，清单里还没有设置页。
  const setPanelBehavior = () =>
    core.tabs.setPanelBehavior().catch((error: unknown) => {
      deps.log.error("设置侧边栏的打开方式失败", errorLabel(error));
    });
  return {
    dispatch: router.dispatch,
    connect: router.connect,
    async onInstalled(reason) {
      // 扩展装上或换了版本，已开页面里的内容脚本不会自动换新；浏览器自己升级不影响它们。
      const reloaded = reason === "install" || reason === "update";
      await Promise.all([setPanelBehavior(), reloaded ? core.reinject() : undefined]);
    },
    onStartup: setPanelBehavior,
    onTabRemoved(tabId) {
      core.contentTabs.remove(tabId);
      core.playbackLimits.forget(tabId);
      void core.sessions.onTabRemoved(tabId).catch((error: unknown) => {
        deps.log.error("删掉关闭标签页的观看会话失败", errorLabel(error));
      });
    },
    async onStorageChanged(changes, area) {
      // 先断端口：启用失效以后，连着的页面不能再发起新的读取和模型请求。
      if (activationLost(changes, area)) router.closeBusinessPorts("NOT_ENABLED");
      const message = appearanceChange(changes, area);
      if (!message) return;
      try {
        await core.messenger.toTabs(await core.contentTargets(), message);
      } catch (error) {
        deps.log.error("把外观变化发给视频页失败", errorLabel(error));
      }
    },
  };
}
