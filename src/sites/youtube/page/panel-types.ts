// 后台和观看页之间读文字稿面板的一问一答：问的形状、页面回的快照，以及后台对快照的核对。只有类型和纯函数。
// 页面和网页共享这块地方，回来的快照按不可信输入核对：字段、类型、大小、视频身份都要对得上，不对的整份不用。
// 顶层只放字面量和函数：构建开关关着时整个模块不进包。

/**
 * 后台问页面要的三种东西：面板快照；只问页面现在是哪个视频、面板内容换过几次；
 * 或者只问页面现在是哪个视频、播放器上已有哪些字幕轨（卡片看这个视频有没有字幕）。
 */
export type PanelRequest =
  | { readonly type: "youtube.panel"; readonly req: { readonly videoId: string } }
  | { readonly type: "youtube.current"; readonly req: { readonly videoId: string } }
  | { readonly type: "youtube.tracks"; readonly req: { readonly videoId: string } };

/**
 * 面板的状态：ready 读到了；closed 面板没打开；reopen 面板是简幕接上之前打开的，认不出是谁的；
 * loading 还在加载；stale 内容还没换成当前视频的；no-entry 页面上没有文字稿入口；filtered 面板里有搜索词，只显示了一部分；
 * chapters 打开的是带页签的面板，选的是章节那一页。
 */
export type PanelState = "ready" | "closed" | "reopen" | "loading" | "stale" | "no-entry" | "filtered" | "chapters";

export interface PanelCue {
  readonly start: number;
  readonly text: string;
}

export interface PanelInfo {
  readonly title: string;
  readonly author: string;
  readonly channelId: string | null;
  readonly description: string;
  /** 读不到时是 0。 */
  readonly durationSec: number;
}

export interface PanelSnapshot {
  /** 页面现在放的视频：地址和观看页外壳都对得上才填，否则是空串。 */
  readonly videoId: string;
  readonly state: PanelState;
  /** 面板内容换过几次：读的前后不一样，说明中途换了内容。 */
  readonly stamp: number;
  /** 面板语言菜单上显示的名字，读不到时是空串。 */
  readonly label: string;
  /** 只有 ready 时有。 */
  readonly cues: readonly PanelCue[];
  readonly info: PanelInfo;
  /** 播放器上已有的字幕轨列表，只有 ready 时问；没问、问不到是 null。 */
  readonly player: PlayerTracks | null;
}

/** 播放器上的一条字幕轨：语言码、平台标的类别、显示名和轨的编号。 */
export interface PlayerTrack {
  readonly lang: string;
  readonly kind: string;
  readonly name: string;
  readonly vssId: string;
}

/** 页面主世界的小桥交回的字幕轨列表，带着播放器现在放的视频，和默认音轨里的默认字幕轨。 */
export interface PlayerTracks {
  readonly videoId: string;
  readonly tracks: readonly PlayerTrack[];
  readonly defaultIndex: number | null;
  readonly hasDefault: boolean | null;
  /** 播放器拿到的这个视频的数据说它能正常播：只有这时轨的列表才算完整。没带时当不知道。 */
  readonly playable?: boolean;
}

/** 页面回的「现在是哪个视频、播放器上有哪些字幕轨」：视频编号的规矩同快照；问不到字幕轨是 null。 */
export interface PanelTracks {
  readonly videoId: string;
  readonly player: PlayerTracks | null;
}

export interface PanelCurrent {
  readonly videoId: string;
  readonly stamp: number;
  readonly label: string;
}

export const PANEL_LIMITS = {
  cues: 20_000,
  cueText: 2_000,
  label: 200,
  title: 500,
  author: 200,
  description: 5_000,
  channelId: 100,
  // 全部段落的字数合计，和导入字幕文件的大小上限对齐。
  totalText: 2_000_000,
  // 一天以内的视频才算。
  seconds: 86_400,
  tracks: 200,
  trackLang: 35,
  trackKind: 16,
  trackName: 200,
  trackId: 100,
} as const;

const STATES: readonly string[] = ["ready", "closed", "reopen", "loading", "stale", "no-entry", "filtered", "chapters"];
export const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const LANG_CODE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
// 字幕的最后一句可以比视频时长晚这么一点，再晚就不是这个视频的。
export const END_SLACK_SEC = 5;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= PANEL_LIMITS.seconds;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function infoOf(value: unknown): PanelInfo | null {
  if (!isRecord(value)) return null;
  const { title, author, channelId, description, durationSec } = value;
  if (!isText(title, PANEL_LIMITS.title) || !isText(author, PANEL_LIMITS.author) || !isText(description, PANEL_LIMITS.description)) return null;
  if (!(channelId === null || isText(channelId, PANEL_LIMITS.channelId)) || !isSeconds(durationSec)) return null;
  return { title, author, channelId, description, durationSec };
}

function cuesOf(value: unknown): PanelCue[] | null {
  if (!Array.isArray(value) || value.length > PANEL_LIMITS.cues) return null;
  const cues: PanelCue[] = [];
  let last = -1;
  let total = 0;
  for (const cue of value) {
    if (!isRecord(cue) || !isSeconds(cue.start) || !isText(cue.text, PANEL_LIMITS.cueText)) return null;
    total += cue.text.length;
    if (total > PANEL_LIMITS.totalText) return null;
    // 时间只许往后走：倒着走说明读到的不是一份完整的文字稿。
    if (cue.start < last) return null;
    last = cue.start;
    cues.push({ start: cue.start, text: cue.text });
  }
  return cues;
}

function trackOf(value: unknown): PlayerTrack | null {
  if (!isRecord(value)) return null;
  const { lang, kind, name, vssId } = value;
  if (!isText(lang, PANEL_LIMITS.trackLang) || !(lang === "" || LANG_CODE.test(lang)) || !isText(kind, PANEL_LIMITS.trackKind)) return null;
  if (!isText(name, PANEL_LIMITS.trackName) || !isText(vssId, PANEL_LIMITS.trackId)) return null;
  return { lang, kind, name, vssId };
}

/** 核对小桥交回的字幕轨列表：主世界和网页共用，形状、大小、视频编号和默认轨的位置有一样不对就整份不用。 */
export function playerTracksOf(value: unknown): PlayerTracks | null {
  if (!isRecord(value)) return null;
  const { videoId, tracks, defaultIndex, hasDefault, playable } = value;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId) || !Array.isArray(tracks) || tracks.length > PANEL_LIMITS.tracks) return null;
  if (!(defaultIndex === null || (isCount(defaultIndex) && defaultIndex < tracks.length)) || !(hasDefault === null || typeof hasDefault === "boolean")) return null;
  if (!(playable === undefined || typeof playable === "boolean")) return null;
  const list: PlayerTrack[] = [];
  for (const raw of tracks) {
    const track = trackOf(raw);
    if (!track) return null;
    list.push(track);
  }
  return { videoId, tracks: list, defaultIndex, hasDefault, ...(typeof playable === "boolean" ? { playable } : {}) };
}

/** 核对页面回的快照，形状不对、超出大小、状态和内容对不上的都是 null。字幕轨列表不对只当没问到。 */
export function panelSnapshotOf(value: unknown): PanelSnapshot | null {
  if (!isRecord(value)) return null;
  const { videoId, state, stamp, label } = value;
  if (typeof videoId !== "string" || (videoId !== "" && !VIDEO_ID.test(videoId))) return null;
  if (typeof state !== "string" || !STATES.includes(state) || !isCount(stamp) || !isText(label, PANEL_LIMITS.label)) return null;
  const info = infoOf(value.info);
  const cues = cuesOf(value.cues);
  if (!info || !cues) return null;
  if ((state === "ready") !== cues.length > 0) return null;
  return { videoId, state: state as PanelState, stamp, label, cues, info, player: playerTracksOf(value.player) };
}

/** 核对页面回的字幕轨问答：形状不对是 null；字幕轨列表不对只当没问到。 */
export function panelTracksOf(value: unknown): PanelTracks | null {
  if (!isRecord(value)) return null;
  const { videoId } = value;
  if (typeof videoId !== "string" || (videoId !== "" && !VIDEO_ID.test(videoId))) return null;
  return { videoId, player: playerTracksOf(value.player) };
}

export function panelCurrentOf(value: unknown): PanelCurrent | null {
  if (!isRecord(value)) return null;
  const { videoId, stamp, label } = value;
  if (typeof videoId !== "string" || (videoId !== "" && !VIDEO_ID.test(videoId)) || !isCount(stamp) || !isText(label, PANEL_LIMITS.label)) return null;
  return { videoId, stamp, label };
}

/**
 * 替用户点开文字稿面板的结果：already-open 本来就开着；opened 点开了、段落出来了；not-opened 点了没开；
 * no-entry 页面上没有入口；ad 正在播广告，没点；video-changed 页面上已经不是这个视频；searching 搜索框里有字，没点。
 */
export type OpenTranscriptOutcome = "already-open" | "opened" | "not-opened" | "no-entry" | "ad" | "video-changed" | "searching";

/** 读完关面板的结果：关上了，或者不是这次从简介点开的、已经不开着、换了视频、搜索框里有字，留着没动。 */
export type CloseTranscriptOutcome = "closed" | "kept";
