/// <reference types="chrome" />
// 卡片页入口：先核对后台是不是同一次构建，再接上消息、配置检查、外观、标签页地址和高度上报。父页面的来源按所在标签页的地址算，高度只报给它。
import { effect, signal } from "@preact/signals";
import { render } from "preact";
import { CARD_TONE, INJECTED } from "../../shared/names.ts";
import { siteRules } from "../../sites/rules.ts";
import { createPageApi, type PageApi } from "../shared/api.ts";
import { startWhenCurrent } from "../shared/build-check.ts";
import { createConfigWatch } from "../shared/config.ts";
import { hostModeOf, pageAppearanceSources, watchAppearance, type ResolvedThemeMode } from "../shared/theme.ts";
import { renderStaleBackground } from "../shared/ui/stale-background.tsx";
import { Card } from "./card.tsx";
import { createCardModel, type CardTab } from "./model.ts";

// 读取中不报高度：「正在读取」那一下报上去，右栏就要多重排一次，推荐列表跟着跳。读得太慢也不一直压着。
const HEIGHT_HOLD_MS = 500;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

async function currentTab(): Promise<CardTab | null> {
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab && typeof tab.id === "number" && typeof tab.url === "string" ? { id: tab.id, url: tab.url } : null;
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// 后台旧了：只显示重新加载的提示，高度照常报给父页面，提示才露得出来。
function stale(root: HTMLElement): void {
  renderStaleBackground(root);
  void currentTab().then((tab) => {
    const parentOrigin = tab ? originOf(tab.url) : null;
    if (!parentOrigin) return;
    const report = (): void => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      window.parent.postMessage({ source: INJECTED.cardMessage, type: "resize", height }, parentOrigin);
    };
    new ResizeObserver(() => requestAnimationFrame(report)).observe(root);
  });
}

function start(root: HTMLElement, api: PageApi): void {
  // 卡片的明暗跟着所在的页面：内容脚本插入时写在地址上，之后页面换了再发消息来；认不出时才按设置。
  let hostMode: ResolvedThemeMode | null = hostModeOf(location.hash);
  const appearance = watchAppearance({ ...pageAppearanceSources(api), hostMode: () => hostMode }, document.documentElement);
  const config = createConfigWatch({ api, enabled: signal(true), storageChanged: chrome.storage.onChanged });
  const model = createCardModel({
    api,
    config: config.state,
    recheckConfig: () => config.check(),
    currentTab,
    parseVideo: (url) => siteRules.bilibili?.parseWatchUrl(url) ?? null,
    seek(tabId, video, atSec) {
      void chrome.tabs.sendMessage(tabId, { type: "player.seek", req: { video, atSec } }, { frameId: 0 }).catch(() => undefined);
    },
    // 卡片框架跟着所在的标签页显隐：后台打开的标签页第一次切到前台才读。
    page: {
      visible: () => document.visibilityState === "visible",
      onVisible(run) {
        const check = (): void => {
          if (document.visibilityState === "visible") run();
        };
        document.addEventListener("visibilitychange", check);
        return () => document.removeEventListener("visibilitychange", check);
      },
    },
  });
  effect(() => {
    void config.state.value;
    model.configChanged();
  });
  // 启用失效：内容脚本会撤下卡片，这里先什么都不显示。
  api.on("activation.changed", ({ confirmed }) => {
    if (!confirmed) void config.check();
  });

  let parentOrigin: string | null = null;
  let lastHeight = -1;
  let heldUntil = 0;
  const report = (): void => {
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (!parentOrigin || height === lastHeight || (model.view.peek().phase === "loading" && Date.now() < heldUntil)) return;
    lastHeight = height;
    window.parent.postMessage({ source: INJECTED.cardMessage, type: "resize", height }, parentOrigin);
  };
  new ResizeObserver(() => requestAnimationFrame(report)).observe(root);
  effect(() => {
    if (model.view.value.phase === "loading") {
      heldUntil = Date.now() + HEIGHT_HOLD_MS;
      setTimeout(report, HEIGHT_HOLD_MS);
    } else requestAnimationFrame(report);
  });

  // 内容脚本在换视频时发来的提醒。页面脚本也能冒充，但收到后只按标签页的真实地址核对一次，冒充不了视频。
  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (event.source !== window.parent || event.origin !== parentOrigin || !isRecord(data)) return;
    if (data.source !== INJECTED.hostMessage) return;
    if (data.type === "recheck") void model.recheck();
    // 页面换了明暗。页面脚本冒充也只能让卡片换个明暗。
    if (data.type === CARD_TONE.message && (data.tone === "light" || data.tone === "dark")) {
      hostMode = data.tone;
      void appearance.then((watch) => watch.refresh());
    }
  });

  const trusted = (event: { readonly isTrusted: boolean }): boolean => event.isTrusted;
  const actions = {
    toggle: () => void model.toggle(),
    generate: (event: { readonly isTrusted: boolean }) => void model.generate(trusted(event)),
    cancel: () => void model.cancel(),
    retry: model.retry,
    openPanel(event: { readonly isTrusted: boolean }) {
      if (!trusted(event)) return;
      void api.send("panel.open", {}).then((reply) => {
        if (!reply.ok || !reply.value.opened) model.view.value = { ...model.view.peek(), notice: { text: "浏览器没让卡片直接打开侧边栏，请点浏览器工具栏里的简幕图标。", tone: "error" } };
      });
    },
    openSettings(event: { readonly isTrusted: boolean }) {
      if (!trusted(event)) return;
      void api.send("options.open", {}).then((reply) => {
        if (!reply.ok) model.view.value = { ...model.view.peek(), notice: { text: "没能打开设置页。可以打开侧边栏，点右上角的设置按钮。", tone: "error" } };
      });
    },
    seek: (atSec: number) => model.seek(atSec),
    toggleShowAll: model.toggleShowAll,
    toggleOfficial: model.toggleOfficial,
  };

  function App() {
    return <Card view={model.view.value} aiReady={model.aiReady.value} actions={actions} />;
  }
  render(<App />, root);

  void model.start().then(() => {
    const tabId = model.tabId();
    if (tabId === null) return;
    void currentTab().then((tab) => {
      parentOrigin = tab ? originOf(tab.url) : null;
      requestAnimationFrame(report);
    });
    // 换视频不刷新页面时，浏览器按地址变化上报；内容脚本也会发一句提醒兜底。
    chrome.tabs.onUpdated.addListener((id, change) => {
      if (id === tabId && typeof change.url === "string") model.urlChanged(change.url);
    });
  });
}

// 扩展重新加载的那一刻，还没撤下的旧卡片会重新载入，这时拿不到扩展接口，什么都不做。
const root = document.getElementById("app");
if (root && globalThis.chrome?.runtime?.id) {
  const api = createPageApi();
  void startWhenCurrent(api, () => start(root, api), () => stale(root));
}
