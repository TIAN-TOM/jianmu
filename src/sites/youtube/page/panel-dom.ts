// 观看页上和文字稿面板有关的结构：读面板和代开面板共用。只有选择器和只读的判断，不点、不改页面。
import type { VideoRef } from "../../../core/video-ref.ts";

// 页面上的各种侧栏面板。文字稿可能在旧面板、新面板，或者带「章节」「文字稿」两个页签的面板里；
// 关着的空壳一直留在页面上，只认展开着、里面有文字稿内容的那个。
export const PANELS = "ytd-engagement-panel-section-list-renderer";
const PANEL_ID_ATTRIBUTE = "target-id";
const TRANSCRIPT_PANEL_IDS = ["engagement-panel-searchable-transcript", "PAmodern_transcript_view"];
export const MODERN_TRANSCRIPT = '[data-target-id="PAmodern_transcript_view"]';
export const TABS = '[role="tab"]';
const EXPANDED_ATTRIBUTE = "visibility";
const EXPANDED = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
// 段落和它的时间、正文：旧面板有两个类名；新面板的时间另有类名，正文是给读屏以外的那段文字。
export const SEGMENTS = "ytd-transcript-segment-renderer, transcript-segment-view-model";
export const SEGMENT_TIME = ".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp";
export const SEGMENT_TEXT = '.segment-text, span[role="text"]';
const SEARCH_BOXES = "input, textarea";
export const LANGUAGE_LABEL = "ytd-transcript-footer-renderer yt-dropdown-menu #label-text";
// 视频简介里打开文字稿的那一块：没有它也没有面板，就是页面上没有文字稿入口。
export const ENTRY = "ytd-video-description-transcript-section-renderer";
// 观看页外壳上标着它正在放的视频；播放器在播广告时标在自己身上的两种状态。
const WATCH_SHELL = "ytd-watch-flexy";
const SHELL_VIDEO_ATTRIBUTE = "video-id";
export const PLAYER = "ytd-watch-flexy .html5-video-player";
const AD_CLASSES = ["ad-showing", "ad-interrupting"];

/** 页面现在放的视频：地址和观看页外壳都对得上才算，换视频的途中是空串。 */
export function videoOnPage(document: Document, ref: VideoRef | null): string {
  const shell = document.querySelector(WATCH_SHELL);
  return ref && shell?.getAttribute(SHELL_VIDEO_ATTRIBUTE) === ref.videoId ? ref.videoId : "";
}

/** 播放器标着正在播广告。 */
export function advertising(document: Document): boolean {
  const player = document.querySelector(PLAYER);
  return player !== null && AD_CLASSES.some((name) => player.classList.contains(name));
}

/** 面板上方的搜索框里有字：只显示了一部分段落。 */
export const searching = (panel: Element | null): boolean =>
  panel !== null && Array.from(panel.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(SEARCH_BOXES)).some((box) => box.value.trim() !== "");

export const expanded = (panel: Element): boolean => panel.getAttribute(EXPANDED_ATTRIBUTE) === EXPANDED;
export const transcriptShell = (panel: Element): boolean => TRANSCRIPT_PANEL_IDS.includes(panel.getAttribute(PANEL_ID_ATTRIBUTE) ?? "");
export const holdsTranscript = (panel: Element): boolean => panel.querySelector(SEGMENTS) !== null || panel.querySelector(MODERN_TRANSCRIPT) !== null;

/** 现在打开着的文字稿面板。chapters：打开的是带页签的面板，选的不是文字稿那一页（里面没有文字稿内容）。 */
export interface OpenPanel {
  readonly panel: Element | null;
  readonly chapters: boolean;
}

export function openPanelOf(panels: readonly Element[]): OpenPanel {
  const open = panels.filter(expanded);
  const withTranscript = open.find(holdsTranscript) ?? open.find(transcriptShell);
  if (withTranscript) return { panel: withTranscript, chapters: false };
  const tabbed = open.find((panel) => panel.querySelector(TABS) !== null);
  return tabbed ? { panel: tabbed, chapters: true } : { panel: null, chapters: false };
}
