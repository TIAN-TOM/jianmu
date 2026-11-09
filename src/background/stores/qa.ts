// 问答仓储：一条问答记下后不改，按视频查，最新的在前。读出来的行不信：形状不对的滤掉，不认识的字段不往外带。
import type { ClearGuard } from "../../core/clear-guard.ts";
import type { QaCitation, QaRecord } from "../../core/notes/records.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

/** 新记录的主键前缀；旧备份里的主键原样保留，也是这个前缀。 */
export const QA_ID_PREFIX = "qa_";

export interface QaChange {
  readonly put?: readonly QaRecord[];
  readonly remove?: readonly string[];
}

export interface QaStoreDeps {
  readonly driver: ObjectStoreDriver<QaRecord>;
  readonly guard: ClearGuard;
}

export interface QaStore {
  /** 全部问答，最新的在前。 */
  readonly all: () => Promise<QaRecord[]>;
  /** 一个视频的问答，最新的在前。 */
  readonly byVideo: (video: VideoKey) => Promise<QaRecord[]>;
  /** 写入一批，坏记录逐条跳过。清除过就不写，返回 false。 */
  readonly commit: (change: QaChange, options?: WriteOptions) => Promise<boolean>;
}

const isCitation = (value: unknown): value is QaCitation => {
  const item = value as Partial<QaCitation> | null;
  return typeof item === "object" && item !== null && Number.isFinite(item.startSeconds) && typeof item.quote === "string";
};

function isValidQa(record: QaRecord): boolean {
  return (
    typeof record.id === "string" &&
    record.id.startsWith(QA_ID_PREFIX) &&
    typeof record.video === "string" &&
    parseVideoKey(record.video) !== null &&
    typeof record.question === "string" &&
    typeof record.answer === "string" &&
    Array.isArray(record.citations) &&
    record.citations.every(isCitation) &&
    Number.isFinite(record.createdAt)
  );
}

// 只留记录类型里有的字段，读写都过这一道。
function cleanQa(record: QaRecord): QaRecord {
  const { id, video, question, answer, citations, clickable, truncated, derived, createdAt } = record;
  return {
    id,
    video,
    question,
    answer,
    citations: citations.map(({ startSeconds, quote }) => ({ startSeconds, quote })),
    clickable: Array.isArray(clickable) ? clickable.filter((seconds) => Number.isFinite(seconds)) : [],
    ...(truncated === true ? { truncated } : {}),
    derived: derived ?? { basis: { source: "legacy-unknown" } },
    createdAt,
  };
}

const readable = (rows: readonly QaRecord[]): QaRecord[] => rows.filter(isValidQa).map(cleanQa);

const newestFirst = (left: QaRecord, right: QaRecord): number => right.createdAt - left.createdAt;

export function createQaStore({ driver, guard }: QaStoreDeps): QaStore {
  const gate = createWriteGate(guard, "all");
  return {
    all: async () => readable(await driver.getAllByIndex("byCreated")).reverse(),
    byVideo: async (video) => readable(await driver.getAllByIndex("byVideo", video)).sort(newestFirst),
    async commit({ put = [], remove = [] }, { since } = {}) {
      const written = await gate(since, async () => {
        await driver.write({ put: readable(put), remove });
        return true;
      });
      return written === true;
    },
  };
}
