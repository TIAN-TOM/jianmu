// YouTube 观看页：认当前视频、听站内换视频、找主视频和悬停图标的挂载点、读控制栏显隐和频道。
// 只读页面结构，不插节点，不发请求，不碰播放器。站内跳转不重新加载页面，脚本在整个站点上跑，只有观看页认得出视频。
import { videoKey, type VideoRef } from "../../core/video-ref.ts";
import type { MainVideo, SitePage } from "../page-types.ts";
import { youtubeRules } from "./url.ts";

// 观看页外壳里的播放器和它的主视频元素。
const PLAYER = "ytd-watch-flexy .html5-video-player";
const VIDEO = "ytd-watch-flexy .html5-video-player video.html5-main-video";
// 播放器在播广告时标在自己身上的两种状态。
const AD_CLASSES = ["ad-showing", "ad-interrupting"];
// 控制栏自动藏起来时播放器带上这个状态。
const AUTOHIDE_CLASS = "ytp-autohide";
// 观看页的外壳，标着它正在放的视频编号。
const WATCH_SHELL = "ytd-watch-flexy";
const SHELL_VIDEO_ATTRIBUTE = "video-id";
const APP_ROOT = "ytd-app";
// 观看页标题下面频道名的链接。
const CHANNEL_LINK_SELECTORS = ["ytd-watch-metadata ytd-channel-name a", "ytd-video-owner-renderer ytd-channel-name a", "#owner ytd-channel-name a"];
const CHANNEL_PATH = /^\/(?:channel\/(UC[\w-]{1,62})|(@[\w.-]{1,64}))(?:[/?#]|$)/;
// 站内跳转完成时页面派发的事件。
const NAVIGATED = "yt-navigate-finish";

// 等页面外壳：先密后疏，没有外壳的页面（嵌入页、弹出的聊天窗口）不一直密集地查。
const READY_POLL_MS = 200;
const READY_POLL_MAX_MS = 5000;
const VIDEO_CHECK_MS = 800;
const CONTROLS_CHECK_MS = 800;

export interface YoutubePageDeps {
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

export function createYoutubePage({ document, location, sleep = waitFor, every = repeat, observeAttribute = watchAttribute }: YoutubePageDeps): SitePage {
  const currentRef = (): VideoRef | null => youtubeRules.parseWatchUrl(location.href);

  /** 观看页外壳上标的视频就是地址上的视频：换视频的途中两者对不上，这时页面上读到的还可能是上一个视频的。 */
  function shellMatches(): boolean {
    const ref = currentRef();
    const shell = document.querySelector(WATCH_SHELL);
    return ref !== null && shell !== null && shell.getAttribute(SHELL_VIDEO_ATTRIBUTE) === ref.videoId;
  }

  return {
    rules: youtubeRules,
    noteShortcut: "n",
    currentRef,

    // 站内跳转完成时页面会派发事件；事件漏了也有定时比地址兜底。
    onVideoChange(cb) {
      let last = keyOf(currentRef());
      const check = (): void => {
        const ref = currentRef();
        const key = keyOf(ref);
        if (key === last) return;
        last = key;
        cb(ref);
      };
      const timed = (): void => {
        if (!document.hidden) check();
      };
      const stop = every(VIDEO_CHECK_MS, timed);
      document.addEventListener(NAVIGATED, check);
      document.addEventListener("visibilitychange", timed);
      return () => {
        stop();
        document.removeEventListener(NAVIGATED, check);
        document.removeEventListener("visibilitychange", timed);
      };
    },

    // 页面的应用外壳出来就算激活：首页、搜索页也一样，界面挂上以后跟着站内跳转走。
    async whenPageReady(signal) {
      let wait = READY_POLL_MS;
      while (document.readyState !== "complete" || !document.querySelector(APP_ROOT)) {
        await sleep(wait, signal);
        wait = Math.min(wait * 2, READY_POLL_MAX_MS);
      }
    },

    findMainVideo(): MainVideo {
      if (!currentRef()) return { status: "none" };
      const player = document.querySelector(PLAYER);
      if (player && AD_CLASSES.some((name) => player.classList.contains(name))) return { status: "ad" };
      const video = document.querySelector<HTMLVideoElement>(VIDEO);
      return video ? { status: "found", video } : { status: "none" };
    },

    // 播放器本身不直接包着视频元素，悬停图标插在它下面不会打断播放。
    hoverIconAnchor() {
      return currentRef() ? document.querySelector(PLAYER) : null;
    },

    // 播放器会被页面换掉，定时重认一次。不在观看页时按没给信号报。
    watchControls(cb) {
      let player: Element | null = null;
      let unobserve = (): void => undefined;
      let last: boolean | null | undefined;
      const read = (): void => {
        const visible = player && currentRef() ? !player.classList.contains(AUTOHIDE_CLASS) : null;
        if (visible === last) return;
        last = visible;
        cb(visible);
      };
      const attach = (): void => {
        const found = document.querySelector(PLAYER);
        if (found !== player) {
          unobserve();
          player = found;
          unobserve = found ? observeAttribute(found, "class", read) : () => undefined;
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

    // 频道编号或频道的 @ 名，换视频的途中不读，免得记到上一个视频的频道上。
    channelId() {
      if (!shellMatches()) return null;
      for (const selector of CHANNEL_LINK_SELECTORS) {
        for (const link of document.querySelectorAll<HTMLAnchorElement>(selector)) {
          const match = CHANNEL_PATH.exec(link.getAttribute("href") ?? "");
          const id = match?.[1] ?? match?.[2];
          if (id) return id;
        }
      }
      return null;
    },

    fillsScreen() {
      return document.fullscreenElement !== null && document.fullscreenElement !== undefined;
    },
  };
}
