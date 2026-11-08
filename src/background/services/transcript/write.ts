// 字幕缓存里存什么、怎么写、怎么变成给页面的回复。缓存里只有能重新取回的内容：视频信息、读到的字幕、
// 列出的字幕轨、UP 主分段和官方总结；字幕文件地址不进缓存，换语言和刷新时重新列轨。导入或移除字幕文件时
// 只作废字幕，视频信息、分段和官方总结留着，所以缓存记录里可以没有字幕。
import type { ClearEpoch } from "../../../core/clear-guard.ts";
import type { TranscriptRef } from "../../../core/notes/records.ts";
import { groupTranscriptEntries } from "../../../core/transcript/segment.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import type {
  ChapterView,
  OfficialStatus,
  OfficialSummaryView,
  OutlineSectionView,
  TrackView,
  TranscriptView,
  VideoInfoView,
} from "../../../shared/messages/transcript.ts";
import type { CaptionTrack, Chapter, Cue, VideoInfo } from "../../../sites/types.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { CacheEntry, CacheStore } from "../../stores/cache.ts";

export interface StoredTranscript {
  readonly ref: TranscriptRef;
  readonly trackId: string;
  readonly label: string;
  readonly cues: readonly Cue[];
  /** 来自用户导入的文件时，文件名。 */
  readonly fileName?: string;
}

/** 存下的官方总结。附带的 AI 字幕不存：用作兜底时它已经是字幕了。 */
export interface StoredOfficial {
  readonly status: OfficialStatus;
  readonly summary: string;
  readonly outline: readonly OutlineSectionView[];
  /** 平台这次附带了 AI 字幕。缓存里沿用这份时就没有字幕可兜底了，兜底要用时得重新问。 */
  readonly hasCaptions: boolean;
  /** 问到的时间：排队中、要登录、没问成的过一阵再问。 */
  readonly fetchedAt: number;
  readonly fingerprint?: string;
}

export interface CachedTranscript {
  /** 这次读取核对过的视频信息。 */
  readonly info: VideoInfo;
  /** 导入或移除字幕文件以后作废，直到下次读到字幕。 */
  readonly transcript?: StoredTranscript;
  /** 列出的字幕轨，不带文件地址。跟着字幕走，字幕作废时一起清空。 */
  readonly tracks: readonly CaptionTrack[];
  readonly chapters: readonly Chapter[];
  /** 站点有这项能力时才有。不跟字幕走，导入、移除字幕文件时留着。 */
  readonly official?: StoredOfficial;
}

/** 一次读取的结果：一定带着字幕。 */
export type TranscriptRecord = CachedTranscript & { readonly transcript: StoredTranscript };

/** 只算响应、从不进缓存的标记：时间轴对不上、刷新取回的对不上而留着原来的。 */
export interface ViewMarks {
  readonly subtitleMismatch?: true;
  readonly refreshMismatched?: true;
}

export type TranscriptCache = CacheStore<CachedTranscript>;

// 只挑要存的字段：适配器的结果对象上多出来的东西不跟着落盘。
const trackOf = ({ trackId, lang, label, kind, isOriginalLang }: CaptionTrack): CaptionTrack =>
  isOriginalLang === undefined ? { trackId, lang, label, kind } : { trackId, lang, label, kind, isOriginalLang };
const cueOf = ({ start, duration, text }: Cue): Cue => ({ start, duration, text });
const chapterOf = ({ title, start, end }: Chapter): Chapter => ({ title, start, end });
const segmentOf = ({ index, title, durationSec }: NonNullable<VideoInfo["segments"]>[number]) => ({ index, title, durationSec });
const outlineOf = ({ title, timestamp, points }: OutlineSectionView): OutlineSectionView => ({
  title,
  timestamp,
  points: points.map((point) => ({ timestamp: point.timestamp, content: point.content })),
});

function officialOf({ status, summary, outline, hasCaptions, fetchedAt, fingerprint }: StoredOfficial): StoredOfficial {
  const picked = { status, summary, outline: outline.map(outlineOf), hasCaptions, fetchedAt };
  return fingerprint === undefined ? picked : { ...picked, fingerprint };
}

/** 给页面看的官方总结：不带问到的时间和有没有附带字幕。 */
export function officialView({ status, summary, outline, fingerprint }: StoredOfficial): OfficialSummaryView {
  const view = { status, summary, outline: outline.map(outlineOf) };
  return fingerprint === undefined ? view : { ...view, fingerprint };
}

function infoOf(info: VideoInfo): VideoInfo {
  const { platform, videoId, segment } = info.ref;
  return {
    ref: segment === undefined ? { platform, videoId } : { platform, videoId, segment },
    title: info.title,
    author: info.author,
    ...(info.channel ? { channel: { platform: info.channel.platform, channelId: info.channel.channelId } } : {}),
    description: info.description,
    durationSec: info.durationSec,
    ...(info.audioLang ? { audioLang: info.audioLang } : {}),
    ...(info.mediaVersion ? { mediaVersion: info.mediaVersion } : {}),
    ...(info.siteRef ? { siteRef: info.siteRef } : {}),
    ...(info.segments ? { segments: info.segments.map(segmentOf) } : {}),
  };
}

function transcriptOf({ ref, trackId, label, cues, fileName }: StoredTranscript): StoredTranscript {
  const picked = { ref: { video: ref.video, kind: ref.kind, lang: ref.lang, fingerprint: ref.fingerprint }, trackId, label, cues: cues.map(cueOf) };
  return fileName === undefined ? picked : { ...picked, fileName };
}

/** 一次读取的结果整理成缓存记录。 */
export function recordOf(
  info: VideoInfo,
  transcript: StoredTranscript,
  tracks: readonly CaptionTrack[],
  chapters: readonly Chapter[],
  official?: StoredOfficial,
): TranscriptRecord {
  const record = { info: infoOf(info), transcript: transcriptOf(transcript), tracks: tracks.map(trackOf), chapters: chapters.map(chapterOf) };
  return official ? { ...record, official: officialOf(official) } : record;
}

/** 缓存记录只留认得的字段：读—改—写交回的对象上夹着别的东西（比如任务快照带来的响应标记），不跟着落盘。 */
export function cleanRecord(record: CachedTranscript): CachedTranscript {
  const base = {
    info: infoOf(record.info),
    tracks: record.tracks.map(trackOf),
    chapters: record.chapters.map(chapterOf),
    ...(record.official ? { official: officialOf(record.official) } : {}),
  };
  return record.transcript ? { ...base, transcript: transcriptOf(record.transcript) } : base;
}

/**
 * 这条记录有字幕，而且是点名的语言（没点名时哪种都行）。点名语言时要的是平台列出的那条轨，
 * 导入的那份和官方总结附带的那份都不顶替。
 */
export function hasTranscript(record: CachedTranscript | null | undefined, lang = ""): record is TranscriptRecord {
  const transcript = record?.transcript;
  if (!transcript) return false;
  const { kind } = transcript.ref;
  return !lang || (kind !== "imported" && kind !== "official-ai" && transcript.ref.lang === lang);
}

/** 给页面看的视频信息：不带平台内部的编号。 */
export function infoView(info: VideoInfo): VideoInfoView {
  return {
    title: info.title,
    author: info.author,
    ...(info.channel ? { channel: { platform: info.channel.platform, channelId: info.channel.channelId } } : {}),
    description: info.description,
    durationSec: info.durationSec,
    ...(info.audioLang ? { audioLang: info.audioLang } : {}),
    ...(info.segments ? { segments: info.segments.map(segmentOf) } : {}),
  };
}

export const tracksView = (tracks: readonly CaptionTrack[]): TrackView[] => tracks.map(trackOf);
export const chaptersView = (chapters: readonly Chapter[]): ChapterView[] => chapters.map(chapterOf);

/** 缓存记录变成回复。只挑认得的字段，记录里夹着的别的东西不带出去，响应专用的标志每次现算。 */
export function viewOf(video: VideoKey, record: TranscriptRecord, fromCache: boolean, marks: ViewMarks = {}): TranscriptView {
  const { transcript } = record;
  const cues = transcript.cues.map(cueOf);
  const body = { ref: transcript.ref, trackId: transcript.trackId, label: transcript.label, cues, segments: groupTranscriptEntries(cues) };
  return {
    video,
    info: infoView(record.info),
    transcript: transcript.fileName === undefined ? body : { ...body, fileName: transcript.fileName },
    tracks: tracksView(record.tracks),
    chapters: chaptersView(record.chapters),
    ...(record.official ? { official: officialView(record.official) } : {}),
    fromCache,
    ...(marks.subtitleMismatch ? { subtitleMismatch: true } : {}),
    ...(marks.refreshMismatched ? { refreshMismatched: true } : {}),
  };
}

export interface TranscriptWriterDeps {
  readonly cache: TranscriptCache;
  /** 这个视频的缓存改了：之后发起的读取不能再并进改之前的在途读取。 */
  readonly changed: (video: VideoKey) => void;
  readonly log: Log;
}

export interface TranscriptWriter {
  /**
   * 读—改—写一次做完，和别的写入排在同一条队列里。mutate 原样交回或交回 null 表示不写。
   * since 之后清除过就不写。写进去的只有认得的字段。返回写入后的记录，没写时是现有的。写不进去时抛错。
   */
  update(video: VideoKey, mutate: (current: CachedTranscript | null) => CachedTranscript | null, since?: ClearEpoch): Promise<CacheEntry<CachedTranscript> | null>;
  /**
   * 一次读取的结果落盘，写不进去不报错。轮到写的那一刻 skip() 为真就不写：排队的工夫清除过、换过字幕文件。
   * keep(现有的) 为真时留着现有的那份不写，把它交回。新建条目以后排一次淘汰，不等它做完。
   */
  save(
    video: VideoKey,
    record: TranscriptRecord,
    since: ClearEpoch | undefined,
    skip?: () => boolean,
    keep?: (current: CachedTranscript | null) => current is TranscriptRecord,
  ): Promise<SaveOutcome>;
}

/** 写进去了没有；留着现有的那份时带上它。 */
export interface SaveOutcome {
  readonly wrote: boolean;
  readonly kept?: TranscriptRecord;
}

// 占位不盖掉同一媒体版本已经有的官方总结：迟到的回填可能赶在这次写入之前落了地。
function withSettledOfficial(record: TranscriptRecord, current: CachedTranscript | null): TranscriptRecord {
  const settled = current?.official;
  if (record.official?.status !== "pending" || !settled || settled.status === "pending") return record;
  return current.info.mediaVersion === record.info.mediaVersion ? { ...record, official: settled } : record;
}

export function createTranscriptWriter({ cache, changed, log }: TranscriptWriterDeps): TranscriptWriter {
  async function update(
    video: VideoKey,
    mutate: (current: CachedTranscript | null) => CachedTranscript | null,
    since?: ClearEpoch,
  ): Promise<CacheEntry<CachedTranscript> | null> {
    let wrote = false;
    const result = await cache.update(
      video,
      (current) => {
        const next = mutate(current);
        wrote = next !== null && next !== current;
        return wrote && next ? cleanRecord(next) : next;
      },
      { since },
    );
    if (wrote) changed(video);
    return result;
  }

  async function save(
    video: VideoKey,
    record: TranscriptRecord,
    since: ClearEpoch | undefined,
    skip?: () => boolean,
    keep?: (current: CachedTranscript | null) => current is TranscriptRecord,
  ): Promise<SaveOutcome> {
    let wrote = false;
    let kept: TranscriptRecord | undefined;
    try {
      await update(
        video,
        (current) => {
          if (skip?.()) return null;
          if (keep?.(current)) {
            kept = current;
            return null;
          }
          wrote = true;
          return withSettledOfficial(record, current);
        },
        since,
      );
    } catch (error) {
      log.error("写入字幕缓存失败", errorLabel(error));
      return { wrote: false };
    }
    // 淘汰要读全量缓存，排在写入队列里随后做，不拖住这次回复。
    if (wrote) void cache.evict().catch((error: unknown) => log.error("清理字幕缓存失败", errorLabel(error)));
    return kept ? { wrote, kept } : { wrote };
  }

  return { update, save };
}
