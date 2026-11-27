// YouTube 观看页：认当前视频、听站内换视频、找主视频、悬停图标和卡片的挂载点、读控制栏显隐和频道。
// 只读页面结构，不插节点，不发请求，不碰播放器。站内跳转不重新加载页面，脚本在整个站点上跑，只有观看页认得出视频。
import { repeat } from "../../core/concurrency.ts";
import type { VideoRef } from "../../core/video-ref.ts";
import type { MainVideo, SitePage } from "../page-types.ts";
import { keyOf, waitFor, watchAttribute } from "../page-util.ts";
import { advertising, MAIN_VIDEO, PANELS, PLAYER, videoOnPage } from "./page/panel-dom.ts";
import { youtubeRules } from "./url.ts";

// 控制栏自动藏起来时播放器带上这个状态。
const AUTOHIDE_CLASS = "ytp-autohide";
// 视频带信息卡片时，播放器右上角有页面自己的信息按钮和卡片提示条，全屏时更大；悬停图标排在它们下面。
const HOVER_ICON_TOP = 76;
const APP_ROOT = "ytd-app";
// 观看页标题下面频道名的链接。
const CHANNEL_LINK_SELECTORS = ["ytd-watch-metadata ytd-channel-name a", "ytd-video-owner-renderer ytd-channel-name a", "#owner ytd-channel-name a"];
const CHANNEL_PATH = /^\/(?:channel\/(UC[\w-]{1,62})|(@[\w.-]{1,64}))(?:[/?#]|$)/;
// 站内跳转完成时页面派发的事件。
const NAVIGATED = "yt-navigate-finish";
// 卡片排在推荐视频上面：右栏里文字稿这些侧栏面板排在推荐视频前面，面板打开时卡片落在面板下面，不挤进面板。
// 剧场模式、窄窗口时页面把推荐视频挪到播放器下面，卡片跟着它走。
const RELATED = "ytd-watch-flexy #related";
// 推荐视频还没出来时排在右栏里，侧栏面板后面。
const SECONDARY_COLUMNS = ["ytd-watch-flexy #secondary-inner", "ytd-watch-flexy #secondary"];

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

/** 在侧栏面板里面：卡片不能插进去，也就不会被当成面板内容读到。 */
const inPanel = (element: Element): boolean => element.closest(PANELS) !== null;

/** 右栏里最后一个侧栏面板（或装着面板的那一层）后面；没有面板时是右栏最上面。 */
function afterPanels(column: Element): Node | null {
  let before: Node | null = column.firstChild;
  for (const child of Array.from(column.children)) {
    if (child.matches(PANELS) || child.querySelector(PANELS) !== null) before = child.nextSibling;
  }
  return before;
}

export function createYoutubePage({ document, location, sleep = waitFor, every = repeat, observeAttribute = watchAttribute }: YoutubePageDeps): SitePage {
  const currentRef = (): VideoRef | null => youtubeRules.parseWatchUrl(location.href);

  return {
    rules: youtubeRules,
    noteShortcut: "n",
    hoverIconTop: HOVER_ICON_TOP,
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
      if (advertising(document)) return { status: "ad" };
      const video = document.querySelector<HTMLVideoElement>(MAIN_VIDEO);
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

    // 频道编号或频道的 @ 名，换视频的途中（观看页外壳上标的视频和地址对不上）不读，免得记到上一个视频的频道上。
    channelId() {
      if (videoOnPage(document, currentRef()) === "") return null;
      for (const selector of CHANNEL_LINK_SELECTORS) {
        for (const link of document.querySelectorAll<HTMLAnchorElement>(selector)) {
          const match = CHANNEL_PATH.exec(link.getAttribute("href") ?? "");
          const id = match?.[1] ?? match?.[2];
          if (id) return id;
        }
      }
      return null;
    },

    // 不在观看页时没有位置：外壳留在页面上，只是藏着。
    cardSlot() {
      if (!currentRef()) return null;
      const related = document.querySelector(RELATED);
      const parent = related?.parentElement;
      if (related && parent && !inPanel(parent)) return { parent, before: related };
      for (const selector of SECONDARY_COLUMNS) {
        const column = document.querySelector(selector);
        if (column && !inPanel(column)) return { parent: column, before: afterPanels(column) };
      }
      return null;
    },

    fillsScreen() {
      return document.fullscreenElement !== null && document.fullscreenElement !== undefined;
    },
  };
}
