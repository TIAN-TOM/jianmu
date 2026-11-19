// 替用户点开文字稿面板：用户点「读取字幕」、打开就出结论和本窗口全部生成读这个视频时由后台转来，只点简介里的入口或文字稿页签一下，
// 点了等结果，不连点、不重试、不滚动、不动播放器、不换语言、不发请求；正在播广告、视频对不上、搜索框里有字时不点；入口还没出来时只看着等一会儿。
// 按结构找，不按文字找。读完后台可以叫这里关上这次从简介点开的面板：只关还开着、还是这个视频、搜索框里没字的那个，用户自己开的、从页签切过去的不关。
import type { VideoRef } from "../../../core/video-ref.ts";
import { advertising, ENTRY, expanded, openPanelOf, PANEL_CLOSE, PANELS, searching, SEGMENTS, TABS, videoOnPage } from "./panel-dom.ts";
import type { CloseTranscriptOutcome, OpenTranscriptOutcome } from "./panel-types.ts";

// 点了以后最多等这么久看面板开没开、段落出没出来，每隔这么久看一次。
const OPEN_WAIT_MS = 6000;
const OPEN_POLL_MS = 200;
// 入口还没出来时最多等这么久：慢一些的加载也等得到，真没有入口的视频不多拖。
export const ENTRY_WAIT_MS = 5000;

export interface PanelOpenerDeps {
  readonly document: Document;
  readonly currentRef: () => VideoRef | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PanelOpener {
  /** 认得的请求回 Promise，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<{ readonly outcome: OpenTranscriptOutcome | CloseTranscriptOutcome }> | null;
}

/** 视频简介里那个入口的按钮：同样的入口一直关着的面板里也有一份，那份不点；简介里没有就算没有入口。 */
function entryButton(document: Document): HTMLElement | null {
  const entry = Array.from(document.querySelectorAll(ENTRY)).find((candidate) => candidate.closest(PANELS) === null);
  return entry?.querySelector<HTMLElement>("button") ?? null;
}

/** 带页签的面板里没选中的那个页签：两个页签里文字稿排在章节后面，取没选中的最后一个。 */
function transcriptTab(panel: Element): HTMLElement | null {
  const idle = Array.from(panel.querySelectorAll<HTMLElement>(TABS)).filter((tab) => tab.getAttribute("aria-selected") !== "true");
  return idle.at(-1) ?? null;
}

export function createPanelOpener({ document, currentRef, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: PanelOpenerDeps): PanelOpener {
  const panelsNow = (): Element[] => Array.from(document.querySelectorAll(PANELS));
  /** 打开着的面板里已经有段落了。 */
  const showing = (): boolean => {
    const { panel, chapters } = openPanelOf(panelsNow());
    return panel !== null && !chapters && panel.querySelector(SEGMENTS) !== null;
  };
  /** 最近一次从简介点开的面板和它的视频：读完可以关上的只有它。 */
  let openedHere: { readonly videoId: string; readonly panel: Element } | null = null;

  /** 这会儿页面上的样子：不用点就有结果的回结果，能点的回要点的那个，还没有能点的是 null。 */
  function look(videoId: string): OpenTranscriptOutcome | { readonly target: HTMLElement; readonly fromEntry: boolean } | null {
    if (videoOnPage(document, currentRef()) !== videoId) return "video-changed";
    if (advertising(document)) return "ad";
    const { panel, chapters } = openPanelOf(panelsNow());
    if (panel && !chapters) return searching(panel) ? "searching" : "already-open";
    const target = chapters && panel ? transcriptTab(panel) : entryButton(document);
    return target ? { target, fromEntry: !(chapters && panel) } : null;
  }

  async function open(videoId: string): Promise<OpenTranscriptOutcome> {
    const looking = now();
    let found = look(videoId);
    while (found === null && now() - looking < ENTRY_WAIT_MS) {
      await sleep(OPEN_POLL_MS);
      found = look(videoId);
    }
    if (found === null) return "no-entry";
    if (typeof found === "string") return found;
    const { target, fromEntry } = found;
    openedHere = null;
    target.click();
    const begun = now();
    while (now() - begun < OPEN_WAIT_MS) {
      await sleep(OPEN_POLL_MS);
      if (videoOnPage(document, currentRef()) !== videoId) return "video-changed";
      if (showing()) {
        const opened = openPanelOf(panelsNow()).panel;
        if (fromEntry && opened) openedHere = { videoId, panel: opened };
        return "opened";
      }
    }
    return "not-opened";
  }

  function close(videoId: string): CloseTranscriptOutcome {
    const opened = openedHere;
    openedHere = null;
    if (!opened || opened.videoId !== videoId || videoOnPage(document, currentRef()) !== videoId) return "kept";
    const { panel } = opened;
    if (!panel.isConnected || !expanded(panel) || searching(panel)) return "kept";
    const button = panel.querySelector<HTMLElement>(PANEL_CLOSE);
    if (!button) return "kept";
    button.click();
    return "closed";
  }

  return {
    handle(message) {
      const request = message as { readonly type?: unknown; readonly req?: { readonly videoId?: unknown } } | null;
      const videoId = request?.req?.videoId;
      if (typeof videoId !== "string") return null;
      if (request?.type === "youtube.openTranscript") return open(videoId).then((outcome) => ({ outcome }));
      if (request?.type === "youtube.closeTranscript") return Promise.resolve({ outcome: close(videoId) });
      return null;
    },
  };
}
