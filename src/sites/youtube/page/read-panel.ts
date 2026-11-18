// 读观看页上已经显示的文字稿面板：只看不动，不点、不滚动、不打开面板、不换语言，不碰播放器，不发请求。
// 字幕段落最后一次真的变了时页面放的是当前视频才认（面板里别的控件变了不算），简幕接上之前就开着的面板认不出是谁的，
// 要用户刷新视频页再开。读到的时间不超过视频时长，超过的整份不用；播广告时不拿时长。
import type { VideoRef } from "../../../core/video-ref.ts";
import { PANEL_LIMITS, type PanelCue, type PanelCurrent, type PanelInfo, type PanelRequest, type PanelSnapshot, type PanelState } from "./panel-types.ts";

// 文字稿面板、它的正文和语言菜单，新旧两种面板的段落写法都认。
const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
const EXPANDED_ATTRIBUTE = "visibility";
const EXPANDED = "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
const SEGMENTS = "ytd-transcript-segment-renderer, transcript-segment-view-model";
const SEGMENT_TIME = ".segment-timestamp";
const SEGMENT_TEXT = ".segment-text";
const LANGUAGE_LABEL = "ytd-transcript-footer-renderer yt-dropdown-menu #label-text";
// 视频简介里打开文字稿的那一块：没有它也没有面板，就是页面上没有文字稿入口。
const ENTRY = "ytd-video-description-transcript-section-renderer";
// 观看页的标题、作者和简介。
const WATCH_SHELL = "ytd-watch-flexy";
const SHELL_VIDEO_ATTRIBUTE = "video-id";
const TITLE = "ytd-watch-metadata h1";
const AUTHOR = "ytd-watch-metadata ytd-channel-name a";
const METADATA = "ytd-watch-metadata";
const DESCRIPTION = "ytd-watch-metadata #description-inline-expander";
const PLAYER = "ytd-watch-flexy .html5-video-player";
const VIDEO = "ytd-watch-flexy .html5-video-player video.html5-main-video";
// 播放器在播广告时标在自己身上的两种状态：这时视频元素的时长是广告的。
const AD_CLASSES = ["ad-showing", "ad-interrupting"];

const TIME = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/;
// 段落签名的校验和：32 位 FNV-1a。只用来看出变没变，不防伪造。
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
// 用户把面板关上再打开以后这么久里段落换掉，算页面为当前视频重新取来的。
const REOPEN_WINDOW_MS = 5000;
// 面板内容还在变时等它停下：隔这么久没变就算加载完，最多等这么久。
const SETTLE_MS = 400;
const LOADING_LIMIT_MS = 4000;
// 文字稿的最后一句可以比视频时长晚这么一点，再晚就不是这个视频的。
const END_SLACK_SEC = 5;

export interface PanelReaderDeps {
  readonly document: Document;
  readonly currentRef: () => VideoRef | null;
  readonly channelId: () => string | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly every?: (ms: number, run: () => void) => () => void;
  readonly observe?: (target: Element, run: () => void) => () => void;
}

export interface PanelReader {
  /** 认得的请求回 Promise，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<PanelSnapshot | PanelCurrent> | null;
  readonly stop: () => void;
}

const ATTACH_MS = 800;

function repeat(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
}

function watchSubtree(target: Element, run: () => void): () => void {
  if (typeof MutationObserver !== "function") return () => undefined;
  const observer = new MutationObserver(run);
  observer.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["visibility"] });
  return () => observer.disconnect();
}

/** 「1:02:03」「12:34」「0:05」换成秒；认不出是 null。 */
export function parseTimestamp(text: string): number | null {
  const match = TIME.exec(text.trim());
  if (!match) return null;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  const value = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number(seconds) < 60 && (match[1] === undefined || Number(minutes) < 60) ? value : null;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);
const squash = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

/** 全部段落文字的校验和：中间哪一段变了也看得出，又不用把全部文字拼成一个大字符串。 */
function checksumOf(texts: readonly string[]): string {
  let hash = FNV_OFFSET;
  for (const text of texts) {
    for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0;
    hash = Math.imul(hash ^ 0x0a, FNV_PRIME) >>> 0;
  }
  return hash.toString(16);
}

/** 面板上方的搜索框里有字：只显示了一部分段落。 */
const searching = (panel: Element | null): boolean =>
  panel !== null && Array.from(panel.querySelectorAll<HTMLInputElement>("input")).some((input) => input.value.trim() !== "");

/** 一段的时间和文字。时间认不出的段落不要。 */
function cueOf(segment: Element): PanelCue | null {
  const timeNode = segment.querySelector(SEGMENT_TIME);
  const textNode = segment.querySelector(SEGMENT_TEXT);
  const time = squash(timeNode?.textContent);
  const whole = squash(segment.textContent);
  // 新式面板没有这两个类名：时间是开头那一截，剩下的是文字。
  const leading = time || (/^(\d{1,2}(?::\d{2}){1,2})\b/.exec(whole)?.[1] ?? "");
  const start = parseTimestamp(leading);
  if (start === null) return null;
  const text = textNode ? squash(textNode.textContent) : squash(whole.slice(whole.indexOf(leading) + leading.length));
  return text ? { start, text: clip(text, PANEL_LIMITS.cueText) } : null;
}

export function createPanelReader({
  document,
  currentRef,
  channelId,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  every = repeat,
  observe = watchSubtree,
}: PanelReaderDeps): PanelReader {
  /**
   * 面板里的字幕属于哪个视频：从空面板填进来、或者用户关上再打开面板后不久换掉的，记下这时页面放的视频；
   * 同一个视频里换语言照旧；面板一直开着、换视频以后在里面直接换了内容的记成空串，不认；null 是简幕接上之前就有的。
   */
  let owner: string | null = null;
  /** 面板现在是空的，或者刚换了一个面板：下一次填进来的是新内容。 */
  let fresh = false;
  /** 面板上次是不是展开着，和最近一次从收起变成展开的时刻。 */
  let wasExpanded = false;
  let reopenedAt = Number.NEGATIVE_INFINITY;
  let reopenedFor = "";
  /** 上次看段落时搜索框里有没有字：搜索滤空、清掉搜索词恢复的段落都不是页面新取来的。 */
  let wasSearching = false;
  let stamp = 0;
  /** 上次看到的段落签名，比它变了才算段落变了。 */
  let lastContent = "";
  let lastChangeTime = 0;
  let watched: Element | null = null;
  let unobserve = (): void => undefined;

  const videoNow = (): string => {
    const ref = currentRef();
    const shell = document.querySelector(WATCH_SHELL);
    return ref && shell?.getAttribute(SHELL_VIDEO_ATTRIBUTE) === ref.videoId ? ref.videoId : "";
  };

  /** 段落的签名：段数、语言菜单的名字和全部段落文字的校验和。按钮这些别的控件不在里面。 */
  const contentOf = (panel: Element | null): string => {
    const segments = panel ? Array.from(panel.querySelectorAll(SEGMENTS)) : [];
    if (segments.length === 0) return "";
    const texts = segments.map((segment) => squash(segment.textContent));
    return [String(segments.length), squash(document.querySelector(LANGUAGE_LABEL)?.textContent), checksumOf(texts)].join("\n");
  };

  // 面板有变化时看段落本身变没变：变了才判这些字幕属于谁。
  const changed = (): void => {
    const panel = document.querySelector(PANEL);
    const expanded = panel?.getAttribute(EXPANDED_ATTRIBUTE) === EXPANDED;
    if (expanded && !wasExpanded) {
      reopenedAt = now();
      reopenedFor = videoNow();
    }
    wasExpanded = expanded;
    const filtering = searching(panel);
    const afterSearch = filtering || wasSearching;
    wasSearching = filtering;
    const content = contentOf(panel);
    if (content === lastContent) return;
    lastContent = content;
    stamp += 1;
    lastChangeTime = now();
    if (!content) {
      // 搜索把段落滤空了不算面板清空：清掉搜索词以后回来的还是原来那份。
      if (!filtering) fresh = true;
      return;
    }
    const current = videoNow();
    const justReopened = current !== "" && reopenedFor === current && now() - reopenedAt <= REOPEN_WINDOW_MS;
    if (!afterSearch && (fresh || justReopened)) owner = current;
    else if (owner !== current || current === "") owner = owner === null ? null : "";
    fresh = false;
  };

  // 面板会被页面换掉，定时重认一次；后来才出现、换了一个面板也算内容变了，接上时就在的不算。
  let attached = false;
  const attach = (): void => {
    const panel = document.querySelector(PANEL);
    if (panel === watched) return;
    unobserve();
    watched = panel;
    unobserve = panel ? observe(panel, changed) : () => undefined;
    // 接上时就在的内容记下来但不认；后来才出现、换了一个面板的，当作从空面板填进来。
    if (attached) {
      fresh = true;
      changed();
    } else {
      lastContent = contentOf(panel);
      fresh = lastContent === "";
      wasExpanded = panel?.getAttribute(EXPANDED_ATTRIBUTE) === EXPANDED;
    }
  };
  attach();
  attached = true;
  const stopAttach = every(ATTACH_MS, attach);

  function info(videoId: string): PanelInfo {
    const player = document.querySelector(PLAYER);
    const advertising = player !== null && AD_CLASSES.some((name) => player.classList.contains(name));
    const video = videoId && !advertising ? document.querySelector<HTMLVideoElement>(VIDEO) : null;
    const duration = video && Number.isFinite(video.duration) && video.duration > 0 && video.duration <= PANEL_LIMITS.seconds ? video.duration : 0;
    const title = squash(document.querySelector(TITLE)?.textContent);
    const author = squash(document.querySelector(AUTHOR)?.textContent);
    const channel = channelId();
    return {
      title: clip(title, PANEL_LIMITS.title),
      author: clip(author, PANEL_LIMITS.author),
      channelId: channel && channel.length <= PANEL_LIMITS.channelId ? channel : null,
      description: clip((document.querySelector(DESCRIPTION)?.textContent ?? "").trim(), PANEL_LIMITS.description),
      durationSec: duration,
    };
  }

  function stateOf(videoId: string): { readonly state: PanelState; readonly cues: PanelCue[] } {
    const panel = document.querySelector(PANEL);
    if (!panel) {
      // 观看页的标题区都还没出来时只是没加载完，不说没有入口。
      if (!document.querySelector(METADATA)) return { state: "loading", cues: [] };
      return { state: document.querySelector(ENTRY) ? "closed" : "no-entry", cues: [] };
    }
    if (panel.getAttribute(EXPANDED_ATTRIBUTE) !== EXPANDED) return { state: "closed", cues: [] };
    // 文字稿上方的搜索框里有字：只显示了一部分，滤空了也一样。
    if (searching(panel)) return { state: "filtered", cues: [] };
    const segments = Array.from(panel.querySelectorAll(SEGMENTS));
    // 没有段落：在加载，或者加载失败只显示了一句话，等一会儿还没有就按加载中报。太长的也不按完整的交。
    if (segments.length === 0 || segments.length > PANEL_LIMITS.cues) return { state: "loading", cues: [] };
    if (owner === null) return { state: "reopen", cues: [] };
    if (!videoId || owner !== videoId) return { state: "stale", cues: [] };
    const cues = segments.flatMap((segment) => cueOf(segment) ?? []);
    if (cues.length === 0) return { state: "loading", cues: [] };
    return { state: "ready", cues };
  }

  /** 时间往后走、最后一句不晚于视频时长，才算一份完整、属于这个视频的文字稿。 */
  function plausible(cues: readonly PanelCue[], durationSec: number): boolean {
    let last = -1;
    for (const cue of cues) {
      if (cue.start < last) return false;
      last = cue.start;
    }
    return durationSec <= 0 || last <= durationSec + END_SLACK_SEC;
  }

  async function snapshot(asked: string): Promise<PanelSnapshot> {
    const begun = now();
    // 内容还在变、或者还在加载时等一会儿，等到停下来再读。
    for (;;) {
      attach();
      // 观察者的回调可能还没轮到：读之前先看一眼段落变没变。
      changed();
      const videoId = videoNow();
      const { state, cues } = stateOf(videoId);
      const settling = now() - lastChangeTime < SETTLE_MS;
      // 用户刚把面板关上再打开，页面还在取这个视频的文字稿：旧段落还没换掉，等一会儿。
      const refetching = state === "stale" && videoId !== "" && reopenedFor === videoId && now() - reopenedAt < REOPEN_WINDOW_MS;
      if ((state === "loading" || refetching || (state === "ready" && settling)) && now() - begun < LOADING_LIMIT_MS) {
        await sleep(SETTLE_MS / 2);
        continue;
      }
      const details = info(videoId);
      const usable = videoId === asked && state === "ready" && plausible(cues, details.durationSec);
      const shown: PanelState = state === "ready" && !usable ? "stale" : state;
      return { videoId, state: shown, stamp, label: clip(squash(document.querySelector(LANGUAGE_LABEL)?.textContent), PANEL_LIMITS.label), cues: shown === "ready" ? cues : [], info: details };
    }
  }

  return {
    handle(message) {
      const request = message as Partial<PanelRequest> | null;
      const videoId = typeof request?.req?.videoId === "string" ? request.req.videoId : null;
      if (videoId === null) return null;
      if (request?.type === "youtube.panel") return snapshot(videoId);
      if (request?.type === "youtube.current") {
        changed();
        return Promise.resolve({ videoId: videoNow(), stamp, label: clip(squash(document.querySelector(LANGUAGE_LABEL)?.textContent), PANEL_LIMITS.label) });
      }
      return null;
    },
    stop() {
      stopAttach();
      unobserve();
    },
  };
}
