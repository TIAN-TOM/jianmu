// 后台和观看页之间读评论区的一问一答（PRD F23、第 8.2 节第 9 条）：问的形状、页面回的结果，以及后台对结果的核对。只有类型和纯函数。
// 页面和网页共享这块地方，回来的结果按不可信输入核对：字段、类型、大小、视频身份都要对得上，不对的整份不用。
// 只在构建开关 FEATURE_COMMENTS 打开时进包。顶层只放字面量和函数。

/** 两种问法：只读页面上已经加载出来的评论；或者评论区还没加载时替用户滚过去一次，等页面自己加载。 */
export type CommentRequest =
  | { readonly type: "youtube.comments"; readonly req: { readonly videoId: string } }
  | { readonly type: "youtube.loadComments"; readonly req: { readonly videoId: string } };

export interface PageComment {
  readonly text: string;
  readonly likes: number;
  readonly pinned: boolean;
}

/** 页面上已经加载出来的评论。videoId 是页面现在放的视频，换视频的途中是空串。 */
export interface CommentReply {
  readonly videoId: string;
  readonly comments: readonly PageComment[];
}

/**
 * 替用户滚一次的结果：loaded 评论加载出来了（本来就有也算）；hidden 标签页不在前台，不滚；ad 正在播广告；
 * busy 用户正在打字或滚动页面；video-changed 视频对不上；no-section 页面上没有评论区；
 * timeout 滚过去等不到评论；interrupted 等的时候用户自己动了页面，没有滚回去。
 */
export type LoadOutcome = "loaded" | "hidden" | "ad" | "busy" | "video-changed" | "no-section" | "timeout" | "interrupted";

export interface LoadReply {
  readonly videoId: string;
  readonly outcome: LoadOutcome;
}

export const COMMENT_LIMITS = { count: 20, text: 1000 } as const;

const VIDEO_ID = /^[A-Za-z0-9_-]{0,64}$/;
const OUTCOMES: readonly string[] = ["loaded", "hidden", "ad", "busy", "video-changed", "no-section", "timeout", "interrupted"];
const MAX_LIKES = 1e12;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

function commentOf(value: unknown): PageComment | null {
  if (!isRecord(value)) return null;
  const { text, likes, pinned } = value;
  if (typeof text !== "string" || text.trim() === "" || text.length > COMMENT_LIMITS.text) return null;
  if (!Number.isSafeInteger(likes) || Number(likes) < 0 || Number(likes) > MAX_LIKES || typeof pinned !== "boolean") return null;
  return { text, likes: Number(likes), pinned };
}

/** 核对页面回的评论：有一条不对就整份不用，多出上限的也整份不用。 */
export function commentReplyOf(value: unknown): CommentReply | null {
  if (!isRecord(value)) return null;
  const { videoId, comments } = value;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId) || !Array.isArray(comments) || comments.length > COMMENT_LIMITS.count) return null;
  const list: PageComment[] = [];
  for (const raw of comments) {
    const comment = commentOf(raw);
    if (!comment) return null;
    list.push(comment);
  }
  return { videoId, comments: list };
}

export function loadReplyOf(value: unknown): LoadReply | null {
  if (!isRecord(value)) return null;
  const { videoId, outcome } = value;
  if (typeof videoId !== "string" || !VIDEO_ID.test(videoId) || typeof outcome !== "string" || !OUTCOMES.includes(outcome)) return null;
  return { videoId, outcome: outcome as LoadOutcome };
}

// 页面上的点赞数是缩写过的：千、百万、十亿，和中文的万、亿；小数点可能是逗号。
const UNITS: Readonly<Record<string, number>> = { k: 1e3, m: 1e6, b: 1e9, 千: 1e3, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8 };

/** 把页面上显示的点赞数换成数字，认不出的按 0。 */
export function likesOf(shown: string | null | undefined): number {
  const text = (shown ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!text) return 0;
  const match = /^(\d+(?:[.,]\d+)*)([kmb千万萬亿億])?$/.exec(text);
  if (!match) return 0;
  const [, digits = "", unit] = match;
  // 带单位时最后一个分隔符是小数点；不带单位时分隔符都是千分位。
  const number = unit ? Number(digits.replace(/[.,](?=\d+$)/, ".").replace(/,/g, "")) : Number(digits.replace(/[.,]/g, ""));
  if (!Number.isFinite(number)) return 0;
  return Math.min(MAX_LIKES, Math.round(number * (unit ? (UNITS[unit] ?? 1) : 1)));
}
