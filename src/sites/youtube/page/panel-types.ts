// 后台和观看页之间读文字稿面板的一问一答：问的形状、页面回的快照，以及后台对快照的核对。只有类型和纯函数。
// 页面和网页共享这块地方，回来的快照按不可信输入核对：字段、类型、大小、视频身份都要对得上，不对的整份不用。

/** 后台问页面要的两种东西：面板快照，或者只问页面现在是哪个视频、面板内容换过几次。 */
export type PanelRequest =
  | { readonly type: "youtube.panel"; readonly req: { readonly videoId: string } }
  | { readonly type: "youtube.current"; readonly req: { readonly videoId: string } };

/**
 * 面板的状态：ready 读到了；closed 面板没打开；reopen 面板是简幕接上之前打开的，认不出是谁的；
 * loading 还在加载；stale 内容还没换成当前视频的；no-entry 页面上没有文字稿入口。
 */
export type PanelState = "ready" | "closed" | "reopen" | "loading" | "stale" | "no-entry";

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
}

export interface PanelCurrent {
  readonly videoId: string;
  readonly stamp: number;
}

export const PANEL_LIMITS = Object.freeze({
  cues: 20_000,
  cueText: 2_000,
  label: 200,
  title: 500,
  author: 200,
  description: 5_000,
  channelId: 100,
  // 一天以内的视频才算。
  seconds: 24 * 3600,
});

const STATES: ReadonlySet<string> = new Set(["ready", "closed", "reopen", "loading", "stale", "no-entry"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
  for (const cue of value) {
    if (!isRecord(cue) || !isSeconds(cue.start) || !isText(cue.text, PANEL_LIMITS.cueText)) return null;
    // 时间只许往后走：倒着走说明读到的不是一份完整的文字稿。
    if (cue.start < last) return null;
    last = cue.start;
    cues.push({ start: cue.start, text: cue.text });
  }
  return cues;
}

/** 核对页面回的快照，形状不对、超出大小、状态和内容对不上的都是 null。 */
export function panelSnapshotOf(value: unknown): PanelSnapshot | null {
  if (!isRecord(value)) return null;
  const { videoId, state, stamp, label } = value;
  if (typeof videoId !== "string" || (videoId !== "" && !VIDEO_ID.test(videoId))) return null;
  if (typeof state !== "string" || !STATES.has(state) || !isCount(stamp) || !isText(label, PANEL_LIMITS.label)) return null;
  const info = infoOf(value.info);
  const cues = cuesOf(value.cues);
  if (!info || !cues) return null;
  if ((state === "ready") !== cues.length > 0) return null;
  return { videoId, state: state as PanelState, stamp, label, cues, info };
}

export function panelCurrentOf(value: unknown): PanelCurrent | null {
  if (!isRecord(value)) return null;
  const { videoId, stamp } = value;
  if (typeof videoId !== "string" || (videoId !== "" && !VIDEO_ID.test(videoId)) || !isCount(stamp)) return null;
  return { videoId, stamp };
}
