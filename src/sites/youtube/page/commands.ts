// 替用户点开文字稿面板：用户点「读取字幕」、打开就出结论和本窗口全部生成读这个视频时由后台转来，只点简介里的入口或文字稿页签一下，
// 点了等结果，不连点、不重试、不滚动、不动播放器（后半读播放器字幕时开关字幕除外）、不换语言、不发请求；正在播广告、视频对不上、搜索框里有字时不点；入口还没出来时只看着等一会儿。
// 按结构找，不按文字找。读完后台可以叫这里关上这次从简介点开的面板：只关还开着、还是这个视频、搜索框里没字的那个，用户自己开的、从页签切过去的不关。
import type { VideoRef } from "../../../core/video-ref.ts";
import { askPlayerCaption } from "./caption-ask.ts";
import type { CaptionOutcome, CaptionReply, CaptionRequest, PlayerCaption } from "./caption-types.ts";
import { advertising, ENTRY, expanded, openPanelOf, PANEL_CLOSE, PANELS, searching, SEGMENTS, TABS, videoOnPage } from "./panel-dom.ts";
import type { CloseTranscriptOutcome, OpenTranscriptOutcome, PlayerTracks } from "./panel-types.ts";
import { askPlayerTracks } from "./player-tracks.ts";

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

// 播放器上的字幕按钮：按类名在播放器里找，开没开看它标着的按下状态，标着不可用或者认不出状态就不点。
const CAPTIONS_BUTTON = "ytd-watch-flexy .html5-video-player .ytp-subtitles-button";
// 点开字幕以后最多等这么久看小桥接没接住，每隔这么久看一次。
export const CAPTION_WAIT_MS = 6000;
const CAPTION_POLL_MS = 200;
// 读完要关字幕时正在播广告：等广告播完再关，最多等这么久，每隔这么久看一次；等不到就不关了。
export const CLOSE_AD_WAIT_MS = 180_000;
const CLOSE_AD_POLL_MS = 1000;

export interface CaptionToggleDeps {
  readonly document: Document;
  readonly currentRef: () => VideoRef | null;
  /** 小桥接住的这个视频的字幕；测试换替身。 */
  readonly caption?: (videoId: string) => PlayerCaption | null;
  readonly tracks?: () => PlayerTracks | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface CaptionToggle {
  /** 认得的请求回 Promise，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<CaptionReply> | null;
}

/**
 * 读播放器取回的字幕：只在构建开关打开、页面上没有文字稿时由后台转来。小桥里已经有就直接交；字幕关着时替用户点一下字幕按钮，
 * 等播放器自己去取，读完只关这次点开的那个（按钮还在、还能用、还标着开、还是这个视频）。一次只点一下，不连点、不重试；
 * 正在播广告、视频对不上、按钮不在或标着不可用时不点；按钮本来就开着却没接住的不点，照实报。
 * 读完要关时正在播广告：先交回结果，等广告播完再关，最多等 CLOSE_AD_WAIT_MS。
 */
export function createCaptionToggle({
  document,
  currentRef,
  caption = (videoId) => askPlayerCaption(document, videoId),
  tracks = () => askPlayerTracks(document),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: CaptionToggleDeps): CaptionToggle {
  const onPage = (videoId: string): boolean => videoOnPage(document, currentRef()) === videoId;
  const reply = (outcome: CaptionOutcome, found: PlayerCaption | null = null): CaptionReply =>
    found ? { outcome: "caught", caption: found, player: tracks() } : { outcome, caption: null, player: null };
  const pressed = (button: Element): string | null => button.getAttribute("aria-pressed");
  const usable = (button: Element): boolean =>
    button.getAttribute("aria-disabled") !== "true" && !button.hasAttribute("disabled") && (pressed(button) === "true" || pressed(button) === "false");

  // 关上这次点开的字幕。没在播广告时当场就点，在播就等它播完再看一遍按钮和视频。
  async function closeAfter(button: HTMLElement, videoId: string): Promise<void> {
    const begun = now();
    while (advertising(document)) {
      if (now() - begun >= CLOSE_AD_WAIT_MS) return;
      await sleep(CLOSE_AD_POLL_MS);
    }
    if (button.isConnected && usable(button) && pressed(button) === "true" && onPage(videoId)) button.click();
  }

  async function read(videoId: string): Promise<CaptionReply> {
    if (!onPage(videoId)) return reply("video-changed");
    const ready = caption(videoId);
    if (ready) return reply("caught", ready);
    if (advertising(document)) return reply("ad");
    const button = document.querySelector<HTMLElement>(CAPTIONS_BUTTON);
    if (!button || !usable(button)) return reply("no-button");
    if (pressed(button) === "true") return reply("on-missed");
    button.click();
    const begun = now();
    let found: PlayerCaption | null = null;
    let changed = false;
    while (now() - begun < CAPTION_WAIT_MS) {
      await sleep(CAPTION_POLL_MS);
      if (!onPage(videoId)) {
        changed = true;
        break;
      }
      found = caption(videoId);
      if (found) break;
    }
    // 不让交回结果跟着等广告：没在播广告时这一步当场点完。
    void closeAfter(button, videoId).catch(() => undefined);
    if (changed) return reply("video-changed");
    return found ? reply("caught", found) : reply("not-caught");
  }

  return {
    handle(message) {
      const request = message as Partial<CaptionRequest> | null;
      const videoId = request?.req?.videoId;
      return request?.type === "youtube.caughtCaptions" && typeof videoId === "string" ? read(videoId) : null;
    },
  };
}
