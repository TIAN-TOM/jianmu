// 替用户点开文字稿面板：只在用户点简幕的「读取字幕」时由后台转来，一次只点一下，点了就等结果，不连点、不重试。
// 能点的只有两样：视频简介里打开文字稿的按钮；面板开着但选在章节那一页时，文字稿那个页签。按结构找，不按文字找。
// 不滚动、不动播放器、不换语言、不发请求；正在播广告、页面上的视频对不上、搜索框里有字时都不点。
import type { VideoRef } from "../../../core/video-ref.ts";
import { advertising, ENTRY, openPanelOf, PANELS, searching, SEGMENTS, TABS, videoOnPage } from "./panel-dom.ts";
import type { OpenTranscriptOutcome } from "./panel-types.ts";

// 点了以后最多等这么久看面板开没开、段落出没出来，每隔这么久看一次。
const OPEN_WAIT_MS = 6000;
const OPEN_POLL_MS = 200;

export interface PanelOpenerDeps {
  readonly document: Document;
  readonly currentRef: () => VideoRef | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PanelOpener {
  /** 认得的请求回 Promise，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<{ readonly outcome: OpenTranscriptOutcome }> | null;
}

/** 视频简介里那个入口的按钮：同样的入口一直关着的面板里也有一份，先用不在面板里的那个。 */
function entryButton(document: Document): HTMLElement | null {
  const entries = Array.from(document.querySelectorAll(ENTRY));
  const entry = entries.find((candidate) => candidate.closest(PANELS) === null) ?? entries[0];
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

  async function open(videoId: string): Promise<OpenTranscriptOutcome> {
    if (videoOnPage(document, currentRef()) !== videoId) return "video-changed";
    if (advertising(document)) return "ad";
    const { panel, chapters } = openPanelOf(panelsNow());
    if (panel && !chapters) return searching(panel) ? "searching" : "already-open";
    const target = chapters && panel ? transcriptTab(panel) : entryButton(document);
    if (!target) return "no-entry";
    target.click();
    const begun = now();
    while (now() - begun < OPEN_WAIT_MS) {
      await sleep(OPEN_POLL_MS);
      if (videoOnPage(document, currentRef()) !== videoId) return "video-changed";
      if (showing()) return "opened";
    }
    return "not-opened";
  }

  return {
    handle(message) {
      const request = message as { readonly type?: unknown; readonly req?: { readonly videoId?: unknown } } | null;
      if (request?.type !== "youtube.openTranscript" || typeof request.req?.videoId !== "string") return null;
      return open(request.req.videoId).then((outcome) => ({ outcome }));
    },
  };
}
