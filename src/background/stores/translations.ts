// 译文仓储：一版字幕译成一种语言是一条记录，整理后的原文（补标点、改同音错字）按 tidy 也记在这里，主键由访问层用视频、字幕指纹和目标语言拼出来，按视频查。
// 记录里按每段原文规范化后的指纹记译文：换了字幕版本，原文没变的段认得出来，不用再付一次钱。
// 不随字幕缓存过期，清除全部数据时才清；进备份，导入时按字幕版本合并。读出来的行不信：形状不对的滤掉，不认识的字段不往外带。
import type { ClearGuard } from "../../core/clear-guard.ts";
import { TEXT_TARGETS, translationId, type Derived, type TranscriptRef, type TranslationRecord } from "../../core/notes/records.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import type { TextTarget } from "../../shared/messages/translate.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

export type { TranslationRecord };

/** 并进一版字幕记录的译文。 */
export interface TranslationPatch {
  readonly transcript: TranscriptRef;
  readonly target: TextTarget;
  readonly segments: Readonly<Record<string, string>>;
  readonly derived: Derived;
}

export interface UpdateOptions extends WriteOptions {
  /** 只读这几条：导入一段时只碰这一段里的主键，不必每段都读整个仓库。不给就读全部。 */
  readonly ids?: readonly string[];
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
  readonly find: (transcript: TranscriptRef, target: TextTarget) => Promise<TranslationRecord | null>;
  /** 一个视频的全部译文记录，较早写的在前。 */
  readonly byVideo: (video: VideoKey) => Promise<TranslationRecord[]>;
  /** 把这几段译文并进这一版的记录，读—改—写排在同一条队列里。清除过、still 回假就不写，返回 false。 */
  readonly merge: (patch: TranslationPatch, options?: MergeOptions) => Promise<boolean>;
  /** 全部记录，导出备份用。 */
  readonly all: () => Promise<TranslationRecord[]>;
  /** 在写入队列里读记录（给了 ids 只读那几条）、算出要写的再写回，导入备份用。清除过就不写，返回 null。 */
  readonly update: <R>(plan: (current: TranslationRecord[]) => { readonly put: readonly TranslationRecord[]; readonly result: R }, options?: UpdateOptions) => Promise<R | null>;
}

const TARGETS: ReadonlySet<string> = new Set<TextTarget>(TEXT_TARGETS);

export { translationId };

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
    async all() {
      return (await driver.getAll()).flatMap((row) => readable(row) ?? []);
    },
    async update(plan, { since, ids } = {}) {
      const done = await gate(since, async () => {
        const rows = ids ? await Promise.all([...new Set(ids)].map((id) => driver.get(id))) : await driver.getAll();
        const current = rows.flatMap((row) => readable(row) ?? []);
        const { put, result } = plan(current);
        if (put.length) await driver.write({ put: put.map(clean) });
        return { result };
      });
      return done === null ? null : done.result;
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
