// B 站播放页：认当前视频、等页面激活、找主视频和两个挂载点、读作者栏上的 UP 主编号。只读页面结构，不插节点，不发请求。
import { videoKey, type VideoRef } from "../../core/video-ref.ts";
import type { MainVideo, SitePage } from "../page-types.ts";
import { bilibiliRules } from "./url.ts";

const VIDEO_SELECTORS = [".bpx-player-video-wrap video", "video"];

// 悬停图标的候选挂载点，依次取第一个不直接包着视频的。
const PLAYER_SELECTORS = [
  "#bilibili-player .bpx-player-primary-area",
  "#bilibili-player",
  ".bpx-player-container",
  "#playerWrap",
];

// 卡片排在右栏的弹幕列表旁边，于是也在推荐视频上面。
const CARD_ANCHOR_SELECTORS = ["#danmukuBox", ".danmaku-box"];
// 没有弹幕列表时放到右栏最上面，依次是新版播放页、合集页、旧版播放页。
const CARD_COLUMN_SELECTORS = [
  ".right-container-inner",
  ".right-container",
  ".playlist-container--right",
  ".r-con",
];

// 播放器容器标着屏幕状态：网页全屏和全屏时页面临时改了右栏。
const SCREEN_CONTAINER = ".bpx-player-container";
const SCREEN_ATTRIBUTE = "data-screen";
const FILLING_SCREENS = new Set(["web", "full"]);
// 同一个容器还标着控制栏这会儿藏没藏。
const CONTROLS_ATTRIBUTE = "data-ctrl-hidden";
const CONTROLS_CHECK_MS = 800;

// UP 主的空间链接：单人投稿在作者栏，合作投稿取第一位。
const CREATOR_LINK_SELECTORS = [".up-info-container a.up-name", ".up-detail-top a.up-name", "a.up-name", ".membersinfo-upcard a", ".up-panel-container a"];
const CREATOR_ID = /space\.bilibili\.com\/(\d{1,20})(?:[/?#]|$)/;

const SERVER_RENDERED_ROOT = "[data-server-rendered]";
const READY_POLL_MS = 200;
const SETTLE_DELAY_MS = 1200;
const VIDEO_CHECK_MS = 800;

export interface BilibiliPageDeps {
  document: Document;
  location: Pick<Location, "href">;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // 中止时要拒绝
  every?: (ms: number, run: () => void) => () => void; // 返回停止函数
  observeAttribute?: (element: Element, name: string, run: () => void) => () => void; // 属性变了就调，返回停止函数
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function repeat(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
}

function watchAttribute(element: Element, name: string, run: () => void): () => void {
  if (typeof MutationObserver !== "function") return () => undefined;
  const observer = new MutationObserver(run);
  observer.observe(element, { attributes: true, attributeFilter: [name] });
  return () => observer.disconnect();
}

const keyOf = (ref: VideoRef | null): string | null => (ref ? videoKey(ref) : null);

// 播放器自己管着直接包视频的那一层，插进外来节点会让它重建，视频加载两遍。
const holdsVideoDirectly = (element: Element): boolean =>
  Array.from(element.children).some((child) => child.tagName === "VIDEO");

export function createBilibiliPage({ document, location, sleep = waitFor, every = repeat, observeAttribute = watchAttribute }: BilibiliPageDeps): SitePage {
  const currentRef = (): VideoRef | null => bilibiliRules.parseWatchUrl(location.href);

  function firstMatch<T extends Element>(selectors: readonly string[]): T | null {
    for (const selector of selectors) {
      const element = document.querySelector<T>(selector);
      if (element) return element;
    }
    return null;
  }

  // 宽屏时弹幕列表被推到视频下面，右栏顶上那一截落在视频底下，卡片要排到弹幕列表后面。
  function pushedBelowPlayer(anchor: Element): boolean {
    const margin = document.defaultView?.getComputedStyle(anchor).marginTop ?? "";
    return Number.parseFloat(margin) > 0;
  }

  return {
    rules: bilibiliRules,
    noteShortcut: "n",
    currentRef,

    // 换视频不刷新页面，靠定时比地址发现。
    onVideoChange(cb) {
      let last = keyOf(currentRef());
      const check = (): void => {
        if (document.hidden) return;
        const ref = currentRef();
        const key = keyOf(ref);
        if (key === last) return;
        last = key;
        cb(ref);
      };
      const stop = every(VIDEO_CHECK_MS, check);
      document.addEventListener("visibilitychange", check);
      return () => {
        stop();
        document.removeEventListener("visibilitychange", check);
      };
    },

    // 页面框架激活之前插节点会打断激活，所以不设时限。
    async whenPageReady(signal) {
      while (document.readyState !== "complete" || document.querySelector(SERVER_RENDERED_ROOT)) {
        await sleep(READY_POLL_MS, signal);
      }
      await sleep(SETTLE_DELAY_MS, signal);
    },

    findMainVideo(): MainVideo {
      const video = firstMatch<HTMLVideoElement>(VIDEO_SELECTORS);
      return video ? { status: "found", video } : { status: "none" };
    },

    hoverIconAnchor() {
      for (const selector of PLAYER_SELECTORS) {
        const element = document.querySelector(selector);
        if (element && !holdsVideoDirectly(element)) return element;
      }
      return null;
    },

    // 容器会被页面换掉，定时重认一次；没标或标了认不出的值都按没给信号报。
    watchControls(cb) {
      let container: Element | null = null;
      let unobserve = (): void => undefined;
      let last: boolean | null = null;
      const read = (): void => {
        const hidden = container?.getAttribute(CONTROLS_ATTRIBUTE);
        const visible = hidden === "false" ? true : hidden === "true" ? false : null;
        if (visible === last) return;
        last = visible;
        cb(visible);
      };
      const attach = (): void => {
        const found = document.querySelector(SCREEN_CONTAINER);
        if (found !== container) {
          unobserve();
          container = found;
          unobserve = found ? observeAttribute(found, CONTROLS_ATTRIBUTE, read) : () => undefined;
        }
        read();
      };
      attach();
      const stop = every(CONTROLS_CHECK_MS, attach);
      return () => {
        stop();
        unobserve();
      };
    },

    cardSlot() {
      const anchor = firstMatch(CARD_ANCHOR_SELECTORS);
      const parent = anchor?.parentElement;
      if (anchor && parent) return { parent, before: pushedBelowPlayer(anchor) ? anchor.nextSibling : anchor };
      const column = firstMatch(CARD_COLUMN_SELECTORS);
      return column ? { parent: column, before: column.firstChild } : null;
    },

    channelId() {
      for (const selector of CREATOR_LINK_SELECTORS) {
        for (const link of document.querySelectorAll<HTMLAnchorElement>(selector)) {
          const id = CREATOR_ID.exec(link.getAttribute("href") ?? "")?.[1];
          if (id) return id;
        }
      }
      return null;
    },

    fillsScreen() {
      return FILLING_SCREENS.has(document.querySelector(SCREEN_CONTAINER)?.getAttribute(SCREEN_ATTRIBUTE) ?? "");
    },
  };
}
