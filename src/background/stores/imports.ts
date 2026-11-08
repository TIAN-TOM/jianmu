// 导入的字幕文件：一个视频一份，后导入的换掉先导入的。这是用户自己的资料：清除缓存不动它，清除全部数据才清，
// 也不进备份。读出来的行不信：视频键对不上、字幕条目不像样的当作没有，记下的视频信息不像样就不用它。
import type { ClearGuard } from "../../core/clear-guard.ts";
import { MAX_ENTRIES, type SubtitleFormat } from "../../core/transcript/import-file.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import type { Cue, VideoInfo } from "../../sites/types.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

export interface ImportRecord {
  readonly videoKey: VideoKey;
  readonly fileName: string;
  readonly format: SubtitleFormat;
  readonly cues: readonly Cue[];
  /** 导入时本机已经知道的视频信息，缓存被清掉以后还能显示标题、核对时间轴；不知道就不记。 */
  readonly info?: VideoInfo;
  readonly importedAt: number;
}

export interface ImportStoreDeps {
  readonly driver: ObjectStoreDriver<ImportRecord>;
  readonly guard: ClearGuard;
}

export interface ImportStore {
  /** 这个视频导入的那份，没有或者读出来不像样时是 null。读不出来时抛错。 */
  readonly get: (video: VideoKey) => Promise<ImportRecord | null>;
  /** 换成 record，null 是删掉；原来那份在同一段里读出来，撤回时用。清除过就不写，回 null。 */
  readonly replace: (video: VideoKey, record: ImportRecord | null, options?: WriteOptions) => Promise<{ readonly previous: ImportRecord | null } | null>;
  /** 改回 previous（null 是删掉）。清除过就不写，回 false。 */
  readonly restore: (video: VideoKey, previous: ImportRecord | null, options?: WriteOptions) => Promise<boolean>;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

const isCue = (value: unknown): value is Cue => isObject(value) && isTime(value.start) && isTime(value.duration) && typeof value.text === "string";

const isInfo = (value: unknown): value is VideoInfo =>
  isObject(value) && isObject(value.ref) && typeof value.title === "string" && typeof value.author === "string" && typeof value.description === "string" && isTime(value.durationSec);

function rowOf(video: VideoKey, row: unknown): ImportRecord | null {
  if (!isObject(row) || row.videoKey !== video || typeof row.fileName !== "string" || (row.format !== "srt" && row.format !== "vtt")) return null;
  const { cues } = row;
  if (!Array.isArray(cues) || cues.length === 0 || cues.length > MAX_ENTRIES || !cues.every(isCue)) return null;
  const importedAt = isTime(row.importedAt) ? row.importedAt : 0;
  const record = { videoKey: video, fileName: row.fileName, format: row.format, cues, importedAt } as const;
  return isInfo(row.info) ? { ...record, info: row.info } : record;
}

export function createImportStore({ driver, guard }: ImportStoreDeps): ImportStore {
  // 清除缓存不动导入的字幕，只有清除全部数据才清。
  const gate = createWriteGate(guard, "all");
  return {
    async get(video) {
      return rowOf(video, await driver.get(video));
    },
    replace: (video, record, { since } = {}) =>
      gate(since, async () => {
        const previous = rowOf(video, await driver.get(video));
        await driver.write(record ? { put: [record] } : { remove: [video] });
        return { previous };
      }),
    async restore(video, previous, { since } = {}) {
      const done = await gate(since, async () => {
        await driver.write(previous ? { put: [previous] } : { remove: [video] });
        return true as const;
      });
      return done === true;
    },
  };
}
