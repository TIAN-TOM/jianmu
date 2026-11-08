// 用户导入的字幕文件：存进 imports 仓库，之后没点名语言的读取先用它，不向平台要任何东西。
// 导入和移除只作废缓存里的字幕（视频信息和分段留着）；作废不掉时撤回这次改动：读取先看缓存，
// 缓存里还是旧字幕的话，存着的文件就和用户看到的对不上了。
// 同一个视频的导入、移除排队做，做着的时候这个视频新来的读取先等它做完：不然作废失败、还没撤回的工夫，
// 新读取会拿马上要撤回的文件组装字幕。
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import { fail, ok, type Result } from "../../../core/errors.ts";
import { transcriptFingerprint } from "../../../core/transcript/fingerprint.ts";
import { isSupportedFileName, parseSubtitleFile } from "../../../core/transcript/import-file.ts";
import { guessSubtitleLanguage } from "../../../core/transcript/language.ts";
import { IMPORTED_SUBTITLE_LABEL } from "../../../core/transcript/sources.ts";
import type { VideoKey, VideoRef } from "../../../core/video-ref.ts";
import type { EmptyRequest } from "../../../shared/messages/core.ts";
import type { ImportReceipt } from "../../../shared/messages/imports.ts";
import type { VideoInfo } from "../../../sites/types.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { ImportRecord, ImportStore } from "../../stores/imports.ts";
import { cleanRecord, recordOf, type CachedTranscript, type TranscriptCache, type TranscriptRecord, type TranscriptWriter } from "./write.ts";

/** 导入的字幕在字幕轨里的编号：不是平台列出的哪一条。 */
const IMPORTED_TRACK_ID = "imported";
const MAX_FILE_NAME = 200;

export interface ImportDeps {
  readonly store: ImportStore;
  readonly cache: TranscriptCache;
  readonly writer: TranscriptWriter;
  readonly guard: ClearGuard;
  readonly now: () => number;
  readonly log: Log;
  /** 这个视频的字幕换了：在途读取不再合并、内存记录作废、字幕代数加一。作废写完以后才调。 */
  readonly changed: (video: VideoKey) => void;
}

export interface Imports {
  /** 这个视频正在导入或移除时，等它做完；没有时是 null。 */
  pending(video: VideoKey): Promise<void> | null;
  /** 读取用：读不出来当作没有导入。 */
  load(video: VideoKey): Promise<ImportRecord | null>;
  add(video: VideoKey, file: { readonly name: string; readonly text: string }): Promise<Result<ImportReceipt>>;
  remove(video: VideoKey): Promise<Result<EmptyRequest>>;
}

/**
 * 导入的文件组装成一次读取的结果。视频信息只用本机已有的：缓存里的、导入时记下的，都没有时拿标签页标题或文件名顶上，
 * 这时 known 为假，调用方不把它写进缓存。语种按正文猜，只用来定翻译方向；分段和官方总结沿用缓存里已有的。
 */
export async function assembleImported(
  ref: VideoRef,
  video: VideoKey,
  imported: ImportRecord,
  stored: CachedTranscript | null,
  fallbackTitle: string | null,
): Promise<{ readonly record: TranscriptRecord; readonly known: boolean }> {
  const knownInfo = stored?.info ?? imported.info;
  const info: VideoInfo = knownInfo ?? { ref, title: fallbackTitle || imported.fileName, author: "", description: "", durationSec: 0 };
  const fingerprint = await transcriptFingerprint(imported.cues);
  const transcript = {
    ref: { video, kind: "imported" as const, lang: guessSubtitleLanguage(imported.cues), fingerprint },
    trackId: IMPORTED_TRACK_ID,
    label: IMPORTED_SUBTITLE_LABEL,
    cues: imported.cues,
    fileName: imported.fileName,
  };
  return { record: recordOf(info, transcript, [], stored?.chapters ?? [], stored?.official), known: knownInfo !== undefined };
}

export function createImports({ store, cache, writer, guard, now, log, changed }: ImportDeps): Imports {
  const changes = new Map<VideoKey, Promise<void>>();

  function change<T>(video: VideoKey, run: () => Promise<T>): Promise<T> {
    const result = (changes.get(video) ?? Promise.resolve()).then(run);
    const settled = result.then(
      () => {},
      () => {},
    );
    changes.set(video, settled);
    void settled.then(() => {
      if (changes.get(video) === settled) changes.delete(video);
    });
    return result;
  }

  // 作废缓存里的字幕：只去掉字幕和跟着它的字幕轨。改不了就整条删掉，官方总结和分段下次再取，总比留着旧字幕好。
  async function invalidate(video: VideoKey): Promise<boolean> {
    try {
      await writer.update(video, (current) => (current?.transcript ? { ...current, transcript: undefined, tracks: [] } : null));
      return true;
    } catch (error) {
      log.error("作废缓存里的字幕失败", errorLabel(error));
      try {
        await cache.remove(video);
        return true;
      } catch (removeError) {
        log.error("删掉缓存里的字幕失败", errorLabel(removeError));
        return false;
      }
    } finally {
      // 写没写成都算换过：这期间开始的读取可能已经拿导入的文件组装过，不能让它落进缓存。
      changed(video);
    }
  }

  async function replace(video: VideoKey, record: ImportRecord | null, since: ClearEpoch | undefined): Promise<"saved" | "cleared" | "stale-cache"> {
    const written = await store.replace(video, record, { since });
    if (!written) return "cleared";
    if (await invalidate(video)) return "saved";
    await store.restore(video, written.previous, { since });
    return "stale-cache";
  }

  return {
    pending: (video) => {
      if (!changes.has(video)) return null;
      return (async () => {
        for (let waiting = changes.get(video); waiting; waiting = changes.get(video)) await waiting;
      })();
    },

    async load(video) {
      try {
        return await store.get(video);
      } catch (error) {
        log.error("读取导入的字幕失败", errorLabel(error));
        return null;
      }
    },

    async add(video, file) {
      const fileName = file.name.slice(0, MAX_FILE_NAME);
      if (!isSupportedFileName(fileName)) return fail("UNSUPPORTED_FILE");
      const parsed = parseSubtitleFile(file.text, fileName);
      if (!parsed.ok) return fail("UNSUPPORTED_FILE", parsed.error);
      const since = guard.epoch();
      return change(video, async () => {
        // 导入时本机已经知道的视频信息一起记下；不为它去问平台，没登录、被限流时导入照样能用。
        const known = await cache.load(video);
        const base = { videoKey: video, fileName, format: parsed.format, cues: parsed.entries, importedAt: now() };
        const record: ImportRecord = known ? { ...base, info: cleanRecord(known).info } : base;
        const outcome = await replace(video, record, since);
        if (outcome === "cleared") return fail("LOCAL_DATA_CLEARED");
        if (outcome === "stale-cache") return fail("CACHE_WRITE_FAILED");
        return ok({ fileName, entries: parsed.entries.length });
      });
    },

    remove(video) {
      const since = guard.epoch();
      return change(video, async () => {
        // 清除全部数据时导入的文件已经一起清掉了，移除照样算成。
        const outcome = await replace(video, null, since);
        return outcome === "stale-cache" ? fail("CACHE_WRITE_FAILED") : ok({});
      });
    },
  };
}
