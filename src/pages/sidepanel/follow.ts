/// <reference types="chrome" />
// 侧边栏跟着本窗口当前的标签页走：切标签页、标签页换地址、后台的跟随广播都重新认一次视频。
// 视频身份按站点规则从标签页地址解析；地址里认不出时，退到这个标签页的观看会话（启用以后才问）。
import { signal, type ReadonlySignal } from "@preact/signals";
import { videoKey, type VideoKey } from "../../core/video-ref.ts";
import { siteRules } from "../../sites/rules.ts";
import type { PageApi } from "../shared/api.ts";

export interface FollowTarget {
  /** 本窗口当前的标签页，还没认出来时是 null。 */
  readonly tabId: number | null;
  readonly video: VideoKey | null;
  /** 标签页标题，视频信息读不到时显示。 */
  readonly title: string;
}

interface TabInfo {
  readonly id?: number;
  readonly windowId?: number;
  readonly url?: string;
  readonly title?: string;
}

interface ChromeEvent<L> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

type ActivatedListener = (info: { readonly tabId: number; readonly windowId: number }) => void;
type UpdatedListener = (tabId: number, change: { readonly url?: string; readonly title?: string }, tab: TabInfo) => void;

/** 用到的 chrome.tabs 和 chrome.windows，测试注入替身。 */
export interface FollowBrowser {
  readonly currentWindowId: () => Promise<number | null>;
  readonly activeTab: (windowId: number) => Promise<TabInfo | null>;
  readonly getTab: (tabId: number) => Promise<TabInfo | null>;
  readonly onActivated: ChromeEvent<ActivatedListener>;
  readonly onUpdated: ChromeEvent<UpdatedListener>;
}

export interface FollowDeps {
  readonly api: Pick<PageApi, "send" | "on">;
  readonly enabled: ReadonlySignal<boolean>;
  readonly browser?: FollowBrowser;
}

export interface Follow {
  readonly target: ReadonlySignal<FollowTarget>;
  /** 重新认一次当前标签页。 */
  refresh(): Promise<void>;
  stop(): void;
}

const NONE: FollowTarget = { tabId: null, video: null, title: "" };

/** 按各站的地址规则认视频；认不出是 null。 */
export function videoOfUrl(url: string | undefined): VideoKey | null {
  if (!url) return null;
  for (const rules of Object.values(siteRules)) {
    const ref = rules?.parseWatchUrl(url);
    if (ref) return videoKey(ref);
  }
  return null;
}

function browserFollow(): FollowBrowser {
  return {
    currentWindowId: () => chrome.windows.getCurrent().then((win) => win.id ?? null, () => null),
    activeTab: (windowId) => chrome.tabs.query({ active: true, windowId }).then((tabs) => tabs[0] ?? null, () => null),
    getTab: (tabId) => chrome.tabs.get(tabId).then((tab) => tab, () => null),
    onActivated: chrome.tabs.onActivated,
    onUpdated: chrome.tabs.onUpdated,
  };
}

export function createFollow({ api, enabled, browser = browserFollow() }: FollowDeps): Follow {
  const target = signal<FollowTarget>(NONE);
  let windowId: number | null = null;
  /** 正在认的标签页：认的途中它换了地址，要再认一次。 */
  let watching: number | null = null;
  let generation = 0;
  let stopped = false;

  async function settle(tab: TabInfo | null): Promise<void> {
    generation += 1;
    const asked = generation;
    if (!tab || typeof tab.id !== "number") {
      watching = null;
      target.value = NONE;
      return;
    }
    const tabId = tab.id;
    watching = tabId;
    let video = videoOfUrl(tab.url);
    if (video === null && enabled.peek()) {
      const reply = await api.send("session.get", { tabId });
      if (stopped || asked !== generation) return;
      video = reply.ok ? (reply.value.session?.video ?? null) : null;
    }
    const next: FollowTarget = { tabId, video, title: tab.title ?? "" };
    const now = target.peek();
    // 同一个标签页、同一个视频只改标题，不换对象，免得各页签以为换了视频重新读取。
    if (now.tabId === next.tabId && now.video === next.video) {
      if (now.title !== next.title) target.value = { ...now, title: next.title };
      return;
    }
    target.value = next;
  }

  async function refresh(): Promise<void> {
    if (windowId === null) windowId = await browser.currentWindowId();
    if (stopped || windowId === null) return;
    await settle(await browser.activeTab(windowId));
  }

  const onActivated: ActivatedListener = ({ tabId, windowId: from }) => {
    if (stopped || from !== windowId) return;
    void browser.getTab(tabId).then((tab) => (stopped ? undefined : settle(tab)));
  };
  const onUpdated: UpdatedListener = (tabId, change, tab) => {
    if (stopped || tabId !== watching || (change.url === undefined && change.title === undefined)) return;
    void settle(tab);
  };
  browser.onActivated.addListener(onActivated);
  browser.onUpdated.addListener(onUpdated);

  const unsubscribe = [
    // 卡片点开侧边栏时后台广播它所在的标签页；不在本窗口的不跟。
    api.on("panel.follow", ({ tabId }) => {
      void browser.getTab(tabId).then((tab) => (stopped || tab?.windowId !== windowId ? undefined : settle(tab)));
    }),
    // 启用以后再认一次：地址里认不出的视频这时才问得了观看会话。
    api.on("activation.changed", ({ confirmed }) => {
      if (confirmed) void refresh();
    }),
  ];

  return {
    target,
    refresh,
    stop() {
      stopped = true;
      browser.onActivated.removeListener(onActivated);
      browser.onUpdated.removeListener(onUpdated);
      for (const off of unsubscribe) off();
    },
  };
}
