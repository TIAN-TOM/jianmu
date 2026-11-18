// 向平台读一次字幕：每次新建一个读取环境，先读视频信息（登录门和付费判断在读取实现里），
// 用核对过的视频信息定下这次读取的视频和媒体版本，之后列轨、读分段、读官方总结、读字幕文件都只用它，不从缓存换。
// 列轨、读分段和官方总结同时发，读取实现会把前两者并成一次列表请求。点名语言时字幕文件读不成（地址可能过期了），
// 重新列一次轨，还在点名的语种里换文件再试；超时、被限流不重列。
import { fail, type Failure } from "../../../core/errors.ts";
import { transcriptFingerprint } from "../../../core/transcript/fingerprint.ts";
import { pickTrack, pickTrackByLang } from "../../../core/transcript/pick-track.ts";
import { videoKey, type Platform, type VideoKey, type VideoRef } from "../../../core/video-ref.ts";
import type { CaptionTrack, Chapter, Cue, SiteCtx, SiteService, VideoInfo } from "../../../sites/types.ts";
import type { Timers } from "../../tasks.ts";
import type { OfficialRead } from "./official.ts";
import { candidatesOf, downloadBudget, downloadFirst, failureOf, type DownloadBudget, type Downloaded } from "./tracks.ts";
import { recordOf, type TranscriptRecord } from "./write.ts";

export interface SiteAccess {
  readonly service: (platform: Platform) => SiteService | undefined;
  /** 一次读取操作用一个，每次新建。标签页号给以后经页面读取的站用。 */
  readonly ctx: (platform: Platform, options: { readonly signal: AbortSignal; readonly tabId?: number | undefined }) => SiteCtx;
}

export interface SiteRead {
  readonly site: SiteService;
  readonly ref: VideoRef;
  readonly video: VideoKey;
  /** 点名的语言，空串是没点名。 */
  readonly lang: string;
  /** 重新列轨：用户刷新或点名语言时。 */
  readonly fresh: boolean;
  /** 缓存记过这个视频有字幕轨：这次列表空着，多半是平台偶发，不说成没有字幕。 */
  readonly knownTracks: boolean;
  readonly ctx: (signal: AbortSignal) => SiteCtx;
  readonly timers: Pick<Timers, "now" | "setTimeout" | "clearTimeout">;
  /** 怎么拿这次读取的官方总结。站点没有这项能力时不给。 */
  readonly official?: ((info: VideoInfo, ctx: SiteCtx) => Promise<OfficialRead>) | undefined;
  /** 读到核对过的视频信息、官方总结也问出去了：卡片等不及这次读取时接着用。 */
  readonly onInfo?: ((info: VideoInfo, official: Promise<OfficialRead> | undefined) => void) | undefined;
}

/** 读到一半失败时手里已有的：视频信息、字幕轨和分段。 */
export interface ReadGuides {
  readonly info?: VideoInfo;
  readonly tracks?: readonly CaptionTrack[];
  readonly chapters?: readonly Chapter[];
}

/** official 是这次读取问的官方总结，读到视频信息以后才有，从不失败。 */
export type SiteReadResult =
  | { readonly ok: true; readonly record: TranscriptRecord; readonly official?: Promise<OfficialRead> | undefined }
  | { readonly ok: false; readonly failure: Failure; readonly guides: ReadGuides; readonly official?: Promise<OfficialRead> | undefined };

const failed = (failure: Failure, guides: ReadGuides = {}, official?: Promise<OfficialRead>): SiteReadResult => ({ ok: false, failure, guides, official });

function sameVideo(info: VideoInfo, video: VideoKey): boolean {
  try {
    return videoKey(info.ref) === video;
  } catch {
    return false;
  }
}

function choose(tracks: readonly CaptionTrack[], lang: string, info: VideoInfo): CaptionTrack | null {
  return lang ? pickTrackByLang(tracks, lang, { strict: true, audioLang: info.audioLang }) : pickTrack(tracks, info.audioLang);
}

export async function readFromSite({ site, ref, video, lang, fresh, knownTracks, ctx: makeCtx, timers, official: askOfficial, onInfo }: SiteRead): Promise<SiteReadResult> {
  // 这次读取自己的取消信号，不跟着哪个调用方走：几个调用方并在一起等同一次读取。
  const controller = new AbortController();
  const ctx = makeCtx(controller.signal);
  const read = await site.readVideoInfo(ref, ctx);
  if (!read.ok) return failed(failureOf(read));
  const info = read.value;
  // 读取实现已经核对过返回的视频，这里再守一道：对不上的整份不用，后面的请求都不发。
  if (!sameVideo(info, video)) return failed(fail("MALFORMED", "video-mismatch"));

  // 和这次读取用同一个环境：已登录的结论接着用，不再多问一次登录。下载到点中止环境时它多半早回来了，
  // 真被一起中止也只是记成没问成，下次再问。
  const official = askOfficial?.(info, ctx);
  onInfo?.(info, official);
  // 重新列轨时分段也跟着重读，免得新列表里的分段被旧记录顶掉。
  const listing = fresh ? { fresh: true } : undefined;
  const [listed, chapterRead] = await Promise.all([
    site.listCaptionTracks(info, ctx, listing),
    site.readCreatorChapters ? site.readCreatorChapters(info, ctx, listing) : Promise.resolve({ ok: true as const, value: [] }),
  ]);
  // 分段读不到不影响字幕。
  const chapters = chapterRead.ok ? chapterRead.value : [];
  if (!listed.ok) return failed(failureOf(listed), { info, chapters }, official);
  let tracks: readonly CaptionTrack[] = listed.value;
  if (tracks.length === 0) {
    return failed(knownTracks ? fail("SUBTITLE_TRACK_MISSING", "list-empty") : fail("NO_CAPTIONS"), { info, chapters }, official);
  }
  const chosen = choose(tracks, lang, info);
  if (!chosen) return failed(fail("SUBTITLE_TRACK_MISSING"), { info, tracks, chapters }, official);

  const budget = downloadBudget(timers, () => controller.abort());
  let downloaded: Downloaded;
  try {
    downloaded = await downloadFirst({ site, info, candidates: candidatesOf(tracks, chosen, lang), ctx, budget });
    if (!downloaded.ok && downloaded.relist && lang && budget.begin()) {
      const second = await relistOnce({ site, info, lang, ctx, budget });
      if (second?.ok) tracks = second.tracks;
      // 第二轮试过的都是空文件时以第一轮的错为准。
      if (second && (second.ok || second.failure.code !== "EMPTY_CAPTION_FILE")) downloaded = second;
    }
  } finally {
    budget.dispose();
  }
  if (!downloaded.ok) return failed(downloaded.failure, { info, tracks, chapters }, official);
  const { track, cues } = downloaded;
  const fingerprint = await transcriptFingerprint(cues);
  const transcript = { ref: { video, kind: track.kind, lang: track.lang, fingerprint }, trackId: track.trackId, label: track.label, cues };
  return { ok: true, record: recordOf(info, transcript, tracks, chapters), official };
}

interface Relist {
  readonly site: SiteService;
  readonly info: VideoInfo;
  readonly lang: string;
  readonly ctx: SiteCtx;
  readonly budget: DownloadBudget;
}

// 重新列一次轨，在点名的语种里再试。重列本身读不成时报重列的错（被限流要让用户知道）；点名的那条轨没了交回 null。
type Relisted = { readonly ok: true; readonly track: CaptionTrack; readonly cues: readonly Cue[]; readonly tracks: readonly CaptionTrack[] } | Extract<Downloaded, { ok: false }>;

async function relistOnce({ site, info, lang, ctx, budget }: Relist): Promise<Relisted | null> {
  const relisted = await site.listCaptionTracks(info, ctx, { fresh: true });
  if (budget.expired) return { ok: false, failure: fail("TIMEOUT", "download-budget"), relist: false };
  if (!relisted.ok) return { ok: false, failure: failureOf(relisted), relist: false };
  const again = choose(relisted.value, lang, info);
  if (!again) return null;
  const second = await downloadFirst({ site, info, candidates: candidatesOf(relisted.value, again, lang), ctx, budget });
  return second.ok ? { ...second, tracks: relisted.value } : second;
}
