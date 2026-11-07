// 读当前视频的字幕轨、字幕正文和 UP 主分段，三样共用一次列表请求。
// 字幕文件的地址只留在这里的内存表，不落盘，不写进报错和日志。
import { videoKey } from "../../core/video-ref.ts";
import type { CaptionTrack, Chapter, Cue, SiteCtx, SiteErrorCode, SiteResult, SiteService, VideoInfo } from "../types.ts";
import { ABORTED, isCaptionFileUrl, PLAYER_URL, untilAborted, type BiliHttp } from "./http.ts";

interface RawTrack {
  readonly lan?: unknown;
  readonly lan_doc?: unknown;
  readonly subtitle_url?: unknown;
  readonly ai_status?: unknown;
  readonly ai_type?: unknown;
}

interface PlayerData {
  readonly need_login_subtitle?: unknown;
  readonly subtitle?: { readonly subtitles?: unknown } | null;
  readonly view_points?: unknown;
}

interface RawLine {
  readonly from?: unknown;
  readonly to?: unknown;
  readonly content?: unknown;
}

interface Row {
  readonly track: CaptionTrack;
  readonly url: string;
}

// 一次列表请求读到的全部内容。
interface Player {
  readonly tracks: readonly CaptionTrack[];
  readonly urls: ReadonlyMap<string, string>; // 字幕轨编号到文件地址
  readonly chapters: readonly Chapter[];
  readonly unusable: boolean; // 平台列了字幕轨，一条能用的地址都没有
}

export interface CaptionsDeps {
  readonly now?: () => number;
}

export type Captions = Pick<Required<SiteService>, "listCaptionTracks" | "readCaptions" | "readCreatorChapters">;

const RECORD_MS = 5 * 60_000;
// 这两种失败只说明这一次没读成，换了地址或重列也一样，记录留着。
const KEEPS_RECORD: ReadonlySet<SiteErrorCode> = new Set(["RATE_LIMITED", "TIMEOUT"]);

const plainText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function secondsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function baseLang(lang: string): string {
  const [base = ""] = lang.replace(/^ai[-_]/i, "").split("-");
  return base.toLowerCase();
}

// 协议相对的地址补上 https，别的协议和不认识的主机都不收。
function fileUrlOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const url = raw.startsWith("//") ? `https:${raw}` : raw;
  return isCaptionFileUrl(url) ? url : null;
}

function rowOf(raw: RawTrack | null): Row | null {
  const url = fileUrlOf(raw?.subtitle_url);
  if (!url) return null;
  const lang = String(raw?.lan || "");
  const generated = Number(raw?.ai_status) > 0 || Number(raw?.ai_type) > 0 || lang.startsWith("ai-");
  return {
    track: { trackId: lang, lang, label: String(raw?.lan_doc || lang), kind: generated ? "auto" : "human" },
    url,
  };
}

function fileKeyOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
}

function langSpecificity(track: CaptionTrack): number {
  let score = track.lang.split("-").filter(Boolean).length;
  if (/Hans|Hant/i.test(track.lang)) score += 2;
  // 地区写法排在简体、繁体之后。
  if (/（中国）|\(中国\)/.test(track.label)) score -= 3;
  return score;
}

// 同一语种指向同一文件时只留语言码更具体的那条；文件不同都留，语种不同也都留。
function withoutRepeats(rows: readonly Row[]): Row[] {
  const byFile = new Map<string, Row>();
  const kept: Row[] = [];
  for (const row of rows) {
    const key = `${baseLang(row.track.lang)}:${fileKeyOf(row.url)}`;
    const previous = byFile.get(key);
    if (!previous) {
      byFile.set(key, row);
      kept.push(row);
    } else if (langSpecificity(row.track) > langSpecificity(previous.track)) {
      kept[kept.indexOf(previous)] = row;
      byFile.set(key, row);
    }
  }
  return kept;
}

// 不标原语言：这里没有可靠的依据，只有一种人工字幕语言也不算。
function parseTracks(raw: unknown): readonly Row[] {
  const list: readonly (RawTrack | null)[] = Array.isArray(raw) ? raw : [];
  const byLang = new Map<string, Row>();
  for (const row of list.map(rowOf)) {
    if (row && !byLang.has(row.track.trackId)) byLang.set(row.track.trackId, row);
  }
  return withoutRepeats([...byLang.values()]);
}

/** 把 UP 主分段规整成内部结构，缺起点的段丢掉，按开始时间排好。 */
export function parseChapters(data: unknown): Chapter[] {
  const points = (data as PlayerData | null)?.view_points;
  const list: readonly (RawLine | null)[] = Array.isArray(points) ? points : [];
  const chapters: Chapter[] = [];
  for (const point of list) {
    const start = secondsOrNull(point?.from);
    if (start === null) continue;
    const end = secondsOrNull(point?.to);
    chapters.push({ title: plainText(point?.content), start, end: end !== null && end > start ? end : null });
  }
  return chapters.sort((left, right) => left.start - right.start);
}

/** 把字幕正文规整成内部结构，空白行丢掉。 */
export function parseCues(payload: unknown): Cue[] {
  const body = (payload as { body?: unknown } | null)?.body;
  const list: readonly (RawLine | null)[] = Array.isArray(body) ? body : [];
  const cues: Cue[] = [];
  for (const line of list) {
    const text = String(line?.content || "").trim();
    if (!text) continue;
    const start = Number(line?.from) || 0;
    const end = Number(line?.to) || start;
    cues.push({ text, start: Math.max(0, start), duration: Math.max(0, end - start) });
  }
  return cues;
}

function parsePlayer(data: unknown): Player {
  const raw = (data as PlayerData | null)?.subtitle?.subtitles;
  const rows = parseTracks(raw);
  return {
    tracks: rows.map((row) => row.track),
    urls: new Map(rows.map((row) => [row.track.trackId, row.url])),
    chapters: parseChapters(data),
    unusable: rows.length === 0 && Array.isArray(raw) && raw.length > 0,
  };
}

const recordKey = (info: VideoInfo): string => `${videoKey(info.ref)}:${info.mediaVersion}`;

export function createCaptions(http: BiliHttp, deps: CaptionsDeps = {}): Captions {
  const now = deps.now ?? Date.now;
  const records = new Map<string, { readonly player: Player; readonly expiresAt: number }>();
  const pending = new Map<string, Promise<SiteResult<Player>>>();

  function remembered(key: string): Player | undefined {
    const record = records.get(key);
    if (record && now() < record.expiresAt) return record.player;
    records.delete(key);
    return undefined;
  }

  // 只记字幕轨非空的结果：一次偶发的空列表不该挡住后面的读取；旧记录也删掉，免得已经不在的轨又被读出来。
  function remember(key: string, player: Player): void {
    if (player.tracks.length === 0) {
      records.delete(key);
      return;
    }
    for (const [other, record] of records) {
      if (now() >= record.expiresAt) records.delete(other);
    }
    records.set(key, { player, expiresAt: now() + RECORD_MS });
  }

  async function readPlayer(info: VideoInfo, cid: string, ctx: SiteCtx): Promise<SiteResult<Player>> {
    const bvid = info.ref.videoId;
    const params: Record<string, string> = info.siteRef ? { aid: info.siteRef, cid, bvid } : { cid, bvid };
    const data = await http.getData({ url: PLAYER_URL, params, signed: true }, ctx);
    if (!data.ok) return data;
    if ((data.value as PlayerData | null)?.need_login_subtitle) {
      http.forgetLogin();
      return { ok: false, code: "NEED_LOGIN", detail: "captions-need-login" };
    }
    return { ok: true, value: parsePlayer(data.value) };
  }

  // 同一视频同一时间只发一个列表请求，不接某个调用方的取消信号。
  function shareRead(info: VideoInfo, cid: string, ctx: SiteCtx): Promise<SiteResult<Player>> {
    const key = recordKey(info);
    const running = pending.get(key);
    if (running) return running;
    const read = readPlayer(info, cid, http.detach(ctx))
      .then((result) => {
        if (result.ok) remember(key, result.value);
        // 平台这次明确不给（要登录、找不到等）时旧记录也作废，后面的读取不能绕过这次拒绝。
        else if (!KEEPS_RECORD.has(result.code)) records.delete(key);
        return result;
      })
      .finally(() => pending.delete(key));
    pending.set(key, read);
    return read;
  }

  async function loadPlayer(
    info: VideoInfo,
    ctx: SiteCtx,
    options: { readonly fresh?: boolean | undefined } = {},
  ): Promise<SiteResult<Player>> {
    const login = await http.requireLogin(ctx);
    if (!login.ok) return login;
    if (!info.mediaVersion) return { ok: false, code: "MALFORMED", detail: "no-media-version" };
    const player = options.fresh ? undefined : remembered(recordKey(info));
    if (player) return { ok: true, value: player };
    if (ctx.signal.aborted) return ABORTED;
    return untilAborted(shareRead(info, info.mediaVersion, ctx), ctx.signal);
  }

  const listCaptionTracks: Captions["listCaptionTracks"] = async (info, ctx, options) => {
    const player = await loadPlayer(info, ctx, options);
    if (!player.ok) return player;
    if (player.value.unusable) return { ok: false, code: "MALFORMED", detail: "no-usable-url" };
    return { ok: true, value: [...player.value.tracks] };
  };

  const readCreatorChapters: Captions["readCreatorChapters"] = async (info, ctx) => {
    const player = await loadPlayer(info, ctx);
    return player.ok ? { ok: true, value: [...player.value.chapters] } : player;
  };

  // 内存表里有地址就用，没有就重列一次。
  async function fileUrl(info: VideoInfo, track: CaptionTrack, ctx: SiteCtx): Promise<SiteResult<string>> {
    const login = await http.requireLogin(ctx);
    if (!login.ok) return login;
    const key = recordKey(info);
    const known = remembered(key)?.urls.get(track.trackId);
    if (known) return { ok: true, value: known };
    const listed = await listCaptionTracks(info, ctx, { fresh: true });
    if (!listed.ok) return listed;
    const url = remembered(key)?.urls.get(track.trackId);
    return url ? { ok: true, value: url } : { ok: false, code: "NO_CAPTIONS", detail: "track-gone" };
  }

  const readCaptions: Captions["readCaptions"] = async (info, track, ctx) => {
    const url = await fileUrl(info, track, ctx);
    if (!url.ok) return url;
    const file = await http.getFile(url.value, ctx);
    if (file.ok) return { ok: true, value: parseCues(file.value) };
    // 地址多半过期了，记录删掉，下一次列轨拿新地址。调用方自己取消的不算。
    if (!KEEPS_RECORD.has(file.code) && !ctx.signal.aborted) records.delete(recordKey(info));
    return file;
  };

  return { listCaptionTracks, readCaptions, readCreatorChapters };
}
