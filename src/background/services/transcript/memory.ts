// 时间轴和视频时长对不上的字幕：照常交给页面，但不进字幕缓存，免得挂错的字幕留上 30 天。
// 概览、问答、翻译都会反复读字幕，每次都去平台重取既慢又费限流额度，所以在内存里记着最近几份，
// 同一视频之后的读取用它，刷新才重新去取；取到对得上的进了缓存就删掉，service worker 回收时一起没了。
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import { subtitleTimelineMismatch } from "../../../core/transcript/mismatch.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import { hasTranscript, type TranscriptRecord } from "./write.ts";

export const MISMATCH_MEMO_LIMIT = 5;

/** 字幕时间轴和这一部分视频的时长对不上。时长按视频信息里当前这一部分的算，拿不到时不判断。 */
export function timelineMismatch(record: TranscriptRecord): boolean {
  return subtitleTimelineMismatch(record.transcript.cues, record.info.durationSec) !== "";
}

export interface MismatchMemory {
  /** 记着的那份，点名语言时只认同一语言的平台字幕。记下之后清除过本机数据的不算。 */
  get(video: VideoKey, lang: string): TranscriptRecord | null;
  /** since 是这次读取开头记下的清除代数。 */
  remember(video: VideoKey, record: TranscriptRecord, since: ClearEpoch | undefined): void;
  drop(video: VideoKey): void;
  /** 改记着的那份，位置不动；mutate 交回 null 表示不改。迟到的官方总结用它填回。 */
  patch(video: VideoKey, mutate: (record: TranscriptRecord) => TranscriptRecord | null): void;
  /** 清除本机数据时全部忘掉，代数加一：之前开始的读取回来时不再往这里记。 */
  forget(): void;
  epoch(): number;
}

export function createMismatchMemory(guard: ClearGuard, limit = MISMATCH_MEMO_LIMIT): MismatchMemory {
  const memo = new Map<VideoKey, { readonly record: TranscriptRecord; readonly since: ClearEpoch | undefined }>();
  let epoch = 0;
  return {
    get(video, lang) {
      const entry = memo.get(video);
      if (!entry) return null;
      if (guard.clearedSince(entry.since, "cache")) {
        memo.delete(video);
        return null;
      }
      return hasTranscript(entry.record, lang) ? entry.record : null;
    },
    remember(video, record, since) {
      // 删了再放，排到最新；超出上限时丢最早记的。
      memo.delete(video);
      memo.set(video, { record, since });
      for (const key of memo.keys()) {
        if (memo.size <= limit) break;
        memo.delete(key);
      }
    },
    drop(video) {
      memo.delete(video);
    },
    patch(video, mutate) {
      const entry = memo.get(video);
      const next = entry ? mutate(entry.record) : null;
      if (entry && next) memo.set(video, { record: next, since: entry.since });
    },
    forget() {
      epoch += 1;
      memo.clear();
    },
    epoch: () => epoch,
  };
}
