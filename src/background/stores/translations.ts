// 译文仓储：一版字幕译成一种语言是一条记录，主键由访问层用视频、字幕指纹和目标语言拼出来，按视频查。
// 记录里按每段原文规范化后的指纹记译文：换了字幕版本，原文没变的段认得出来，不用再付一次钱。
// 不随字幕缓存过期，清除全部数据时才清。读出来的行不信：形状不对的滤掉，不认识的字段不往外带。
import type { ClearGuard } from "../../core/clear-guard.ts";
import type { Derived, TranscriptRef } from "../../core/notes/records.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import type { TranslateTarget } from "../../shared/messages/translate.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

export interface TranslationRecord {
  readonly id: string;
  readonly video: VideoKey;
  /** 译的是哪一版字幕。 */
  readonly transcript: TranscriptRef;
  readonly target: TranslateTarget;
  /** 段的原文指纹 → 译文。 */
  readonly segments: Readonly<Record<string, string>>;
  /** 最近一次写入的依据和生成配置。 */
  readonly derived: Derived;
  readonly updatedAt: number;
}

/** 并进一版字幕记录的译文。 */
export interface TranslationPatch {
  readonly transcript: TranscriptRef;
  readonly target: TranslateTarget;
  readonly segments: Readonly<Record<string, string>>;
  readonly derived: Derived;
}

export interface MergeOptions extends WriteOptions {
  /** 轮到写的那一刻再问一次还要不要写：写的一方另有要核对的（比如这期间换过字幕文件）。 */
  readonly still?: () => boolean;
}

export interface TranslationStoreDeps {
  readonly driver: ObjectStoreDriver<TranslationRecord>;
  readonly guard: ClearGuard;
  readonly now: () => number;
}

export interface TranslationStore {
  /** 这一版字幕译成这种语言的记录。 */
  readonly find: (transcript: TranscriptRef, target: TranslateTarget) => Promise<TranslationRecord | null>;
  /** 一个视频的全部译文记录，较早写的在前。 */
  readonly byVideo: (video: VideoKey) => Promise<TranslationRecord[]>;
  /** 把这几段译文并进这一版的记录，读—改—写排在同一条队列里。清除过、still 回假就不写，返回 false。 */
  readonly merge: (patch: TranslationPatch, options?: MergeOptions) => Promise<boolean>;
}

const TARGETS: ReadonlySet<string> = new Set<TranslateTarget>(["zh", "en"]);

export const translationId = (transcript: TranscriptRef, target: TranslateTarget): string => `${transcript.video}|${transcript.fingerprint}|${target}`;

const isText = (value: unknown): value is string => typeof value === "string";

function isTranscriptRef(value: unknown): value is TranscriptRef {
  const ref = value as Partial<TranscriptRef> | null;
  return typeof ref === "object" && ref !== null && isText(ref.video) && isText(ref.kind) && isText(ref.lang) && isText(ref.fingerprint) && ref.fingerprint !== "";
}

function isValid(record: TranslationRecord): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    isText(record.video) &&
    parseVideoKey(record.video) !== null &&
    isTranscriptRef(record.transcript) &&
    record.transcript.video === record.video &&
    TARGETS.has(record.target) &&
    record.id === translationId(record.transcript, record.target) &&
    typeof record.segments === "object" &&
    record.segments !== null &&
    typeof record.derived === "object" &&
    record.derived !== null
  );
}

// 只留记录类型里有的字段，读写都过这一道；译文只留非空字符串。
function clean(record: TranslationRecord): TranslationRecord {
  const { id, video, transcript, target, segments, derived, updatedAt } = record;
  const kept = Object.entries(segments).filter((entry): entry is [string, string] => isText(entry[1]) && entry[1] !== "");
  return {
    id,
    video,
    transcript: { video: transcript.video, kind: transcript.kind, lang: transcript.lang, fingerprint: transcript.fingerprint },
    target,
    segments: Object.fromEntries(kept),
    derived,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

const readable = (row: TranslationRecord | undefined | null): TranslationRecord | null => (row && isValid(row) ? clean(row) : null);

export function createTranslationStore({ driver, guard, now }: TranslationStoreDeps): TranslationStore {
  const gate = createWriteGate(guard, "all");
  return {
    find: async (transcript, target) => readable(await driver.get(translationId(transcript, target))),
    async byVideo(video) {
      const rows = await driver.getAllByIndex("byVideo", video);
      return rows.flatMap((row) => readable(row) ?? []).sort((left, right) => left.updatedAt - right.updatedAt);
    },
    async merge(patch, { since, still } = {}) {
      const id = translationId(patch.transcript, patch.target);
      const written = await gate(since, async () => {
        const current = readable(await driver.get(id));
        if (still && !still()) return false;
        const record = clean({
          id,
          video: patch.transcript.video,
          transcript: patch.transcript,
          target: patch.target,
          segments: { ...current?.segments, ...patch.segments },
          derived: patch.derived,
          updatedAt: now(),
        });
        await driver.write({ put: [record] });
        return true;
      });
      return written === true;
    },
  };
}
