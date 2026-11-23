// 播放器取回的字幕在小桥、内容脚本和后台之间传的形状，以及每一站对它的核对。只有类型和纯函数。
// 主世界和网页共用页面事件，回来的东西按不可信输入核对：字段、类型、大小、视频编号有一样不对就整份不用。
// 只从读播放器字幕的那几个模块引用，顶层只放字面量和函数：构建开关关着时整个模块不进包。
import { LANG_CODE, playerTracksOf, VIDEO_ID, type PlayerTracks } from "./panel-types.ts";

/** 播放器取回的一份字幕：哪个视频、什么语言、是不是自动生成、是不是机器翻译和译成的语言，以及正文。 */
export interface PlayerCaption {
  readonly videoId: string;
  readonly lang: string;
  readonly auto: boolean;
  readonly translated: boolean;
  /** 机器翻译译成的语言，不是机器翻译时是空串。 */
  readonly targetLang: string;
  readonly text: string;
}

export const CAPTION_LIMITS = {
  // 正文的字数上限，超了不存。
  text: 4_000_000,
  // 页面事件里一份回答的字数上限：正文加上几个短字段。
  answer: 4_001_000,
  // 小桥里最多留几份。
  kept: 2,
} as const;

/** 问内容脚本要播放器字幕的请求。 */
export interface CaptionRequest {
  readonly type: "youtube.caughtCaptions";
  readonly req: { readonly videoId: string };
}

/**
 * 内容脚本读播放器字幕的结果：caught 接住了；video-changed 页面上已经不是这个视频；ad 正在播广告，没点；
 * no-button 播放器上没有字幕按钮或者标着不可用，没点；on-missed 字幕本来就开着，可没接住；not-caught 点开以后等了一会儿也没接住。
 */
export type CaptionOutcome = "caught" | "video-changed" | "ad" | "no-button" | "on-missed" | "not-caught";

export interface CaptionReply {
  readonly outcome: CaptionOutcome;
  /** 只有 caught 时有。 */
  readonly caption: PlayerCaption | null;
  /** 播放器上的字幕轨列表，只有 caught 时问；问不到是 null。 */
  readonly player: PlayerTracks | null;
}

const OUTCOMES: readonly string[] = ["caught", "video-changed", "ad", "no-button", "on-missed", "not-caught"];
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isLang = (value: unknown): value is string => typeof value === "string" && value.length <= 35 && LANG_CODE.test(value);

/** 核对一份字幕：形状、大小、编号和语言的写法；机器翻译的要带译成的语言，不是的不许带。 */
export function playerCaptionOf(value: unknown): PlayerCaption | null {
  if (!isRecord(value)) return null;
  const { videoId, lang, auto, translated, targetLang, text } = value;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId) || !isLang(lang) || typeof auto !== "boolean" || typeof translated !== "boolean") return null;
  if (translated ? !isLang(targetLang) : targetLang !== "") return null;
  if (typeof text !== "string" || text.length === 0 || text.length > CAPTION_LIMITS.text) return null;
  return { videoId, lang, auto, translated, targetLang: targetLang as string, text };
}

/** 核对内容脚本的回答：接住了必须带着字幕，别的结果不许带。 */
export function captionReplyOf(value: unknown): CaptionReply | null {
  if (!isRecord(value) || typeof value.outcome !== "string" || !OUTCOMES.includes(value.outcome)) return null;
  const outcome = value.outcome as CaptionOutcome;
  if (outcome !== "caught") return value.caption === null || value.caption === undefined ? { outcome, caption: null, player: null } : null;
  const caption = playerCaptionOf(value.caption);
  return caption ? { outcome, caption, player: playerTracksOf(value.player) } : null;
}
