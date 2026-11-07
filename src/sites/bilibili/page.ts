// B 站播放页：认当前视频、等页面激活、找主视频和两个挂载点。只读页面结构，不插节点，不发请求。
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

const SERVER_RENDERED_ROOT = "[data-server-rendered]";
const READY_POLL_MS = 200;
const SETTLE_DELAY_MS = 1200;
const VIDEO_CHECK_MS = 800;

export interface BilibiliPageDeps {
  document: Document;
  location: Pick<Location, "href">;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // 中止时要拒绝
  every?: (ms: number, run: () => void) => () => void; // 返回停止函数
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

const keyOf = (ref: VideoRef | null): string | null => (ref ? videoKey(ref) : null);

// 播放器自己管着直接包视频的那一层，插进外来节点会让它重建，视频加载两遍。
const holdsVideoDirectly = (element: Element): boolean =>
  Array.from(element.children).some((child) => child.tagName === "VIDEO");

export function createBilibiliPage({ document, location, sleep = waitFor, every = repeat }: BilibiliPageDeps): SitePage {
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

    cardSlot() {
      const anchor = firstMatch(CARD_ANCHOR_SELECTORS);
      const parent = anchor?.parentElement;
      if (anchor && parent) return { parent, before: pushedBelowPlayer(anchor) ? anchor.nextSibling : anchor };
      const column = firstMatch(CARD_COLUMN_SELECTORS);
      return column ? { parent: column, before: column.firstChild } : null;
    },
  };
}
