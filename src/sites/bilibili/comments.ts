// 读当前视频按热度排的第一页评论（PRD F23）：只读正文、点赞数和是否置顶，不读评论者身份。
// 只在构建开关 FEATURE_COMMENTS 打开时进包，只从 service.ts 的开关分支引用。
import type { SiteCtx, SiteResult, TopComment, VideoInfo } from "../types.ts";
import { REPLY_URL, type BiliHttp } from "./http.ts";

interface RawReply {
  readonly rpid?: unknown;
  readonly like?: unknown;
  readonly invisible?: unknown;
  readonly content?: { readonly message?: unknown } | null;
}

interface ReplyPage {
  readonly replies?: unknown;
  readonly top_replies?: unknown;
}

/** 一次最多交出的条数，和平台第一页一样多。 */
export const COMMENT_LIMIT = 20;
/** 单条正文最多留的字数，超出的截掉，免得一条长评占满材料。 */
export const COMMENT_MAX_CHARS = 1000;

const HOT_ORDER = "3";
const VIDEO_KIND = "1";

function parseReply(raw: RawReply | null, pinned: boolean): { id: string; comment: TopComment } | null {
  if (raw?.invisible === true) return null;
  const text = typeof raw?.content?.message === "string" ? raw.content.message.trim().slice(0, COMMENT_MAX_CHARS) : "";
  if (!text) return null;
  const likes = Number(raw?.like);
  return { id: String(raw?.rpid ?? ""), comment: { text, likes: Number.isFinite(likes) && likes > 0 ? Math.floor(likes) : 0, pinned } };
}

function listOf(value: unknown): readonly (RawReply | null)[] {
  return Array.isArray(value) ? value : [];
}

/** 置顶的排前面，同一条在两处都出现时只留置顶那份，最多交出 COMMENT_LIMIT 条。 */
export function parseTopComments(data: unknown): SiteResult<TopComment[]> {
  if (typeof data !== "object" || data === null) return { ok: false, code: "MALFORMED", reach: "item", detail: "no-reply-data" };
  const page = data as ReplyPage;
  if (page.replies !== undefined && page.replies !== null && !Array.isArray(page.replies)) {
    return { ok: false, code: "MALFORMED", reach: "item", detail: "replies-not-list" };
  }
  const seen = new Set<string>();
  const comments: TopComment[] = [];
  const parsed = [
    ...listOf(page.top_replies).map((raw) => parseReply(raw, true)),
    ...listOf(page.replies).map((raw) => parseReply(raw, false)),
  ];
  for (const entry of parsed) {
    if (!entry || comments.length >= COMMENT_LIMIT) continue;
    if (entry.id && seen.has(entry.id)) continue;
    if (entry.id) seen.add(entry.id);
    comments.push(entry.comment);
  }
  return { ok: true, value: comments };
}

/** 读一次，不翻页；登录门、限速和退避都在请求出口里，被拒或限流就照实交回，不另外再试。 */
export async function readTopComments(http: BiliHttp, info: VideoInfo, ctx: SiteCtx): Promise<SiteResult<TopComment[]>> {
  if (!info.siteRef) return { ok: false, code: "MALFORMED", reach: "item", detail: "no-video-number" };
  const params = { oid: info.siteRef, type: VIDEO_KIND, mode: HOT_ORDER };
  const data = await http.getData({ url: REPLY_URL, params }, ctx);
  return data.ok ? parseTopComments(data.value) : data;
}

/** 给站点服务的那一项。 */
export function commentReader(http: BiliHttp): (info: VideoInfo, ctx: SiteCtx) => Promise<SiteResult<TopComment[]>> {
  return (info, ctx) => readTopComments(http, info, ctx);
}
