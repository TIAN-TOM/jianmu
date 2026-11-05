// 概览仓储：每个视频一条，不随字幕缓存过期。生成、补块、补存和导入都写这里，
// 都排在同一条写队列上；要先读再写的用 update、updateRecord，读和写一次做完。
import type { ClearGuard } from "../../core/clear-guard.ts";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import { normalizeAnalysisFailures, OVERVIEW_RECORD_VERSION, type OverviewRecord } from "../../core/notes/records.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

const TITLE_MAX = 500;
const AUTHOR_MAX = 300;

export interface OverviewFields {
  readonly videoKey: VideoKey;
  readonly title?: string;
  readonly author?: string;
  readonly analysisFailures?: unknown;
}

export interface OverviewInput extends OverviewFields {
  readonly analysis: LearningAnalysis;
}

export interface OverviewChange<R = unknown> {
  readonly put?: readonly OverviewRecord[];
  readonly remove?: readonly VideoKey[];
  readonly result?: R;
}

export interface OverviewSaveOptions extends WriteOptions {
  /** 只在还没有这条记录时写入，已有的（可能更新）一律不碰。 */
  readonly onlyIfMissing?: boolean;
}

export interface OverviewStoreDeps {
  readonly driver: ObjectStoreDriver<OverviewRecord>;
  readonly guard: ClearGuard;
  readonly now?: () => number;
}

export interface OverviewStore {
  readonly all: () => Promise<OverviewRecord[]>;
  readonly find: (key: VideoKey) => Promise<OverviewRecord | null>;
  /** 写入一条现成的记录。清除过就不写，返回 false。 */
  readonly put: (record: OverviewRecord, options?: WriteOptions) => Promise<boolean>;
  /** 按输入建一条记录写入，返回写下的记录；没写时返回 null。 */
  readonly save: (input: OverviewInput, options?: OverviewSaveOptions) => Promise<OverviewRecord | null>;
  /**
   * 只改一条记录的概览：mutate 拿到写队列里现读的概览（没有时是 null），返回新的概览，
   * 交回空值或原样交回表示不写。请求开始前读的快照可能已经过时，写回必须基于现读的这份，
   * 其余字段照旧；还没有这条记录时用 fields 新建。返回写入后的记录，没写时返回现有的，清除过时返回 null。
   */
  readonly updateAnalysis: (
    fields: OverviewFields,
    mutate: (current: LearningAnalysis | null) => LearningAnalysis | null | undefined,
    options?: WriteOptions,
  ) => Promise<OverviewRecord | null>;
  /**
   * 读—改—写一次做完：plan 拿到现读的全部记录，返回要写的改动和结果。清除过就不调用 plan，返回 null。
   * plan 里不要再调这个仓储的写方法，它们排在这次后面，会一直等下去。
   */
  readonly update: <R>(
    plan: (current: OverviewRecord[]) => OverviewChange<R> | Promise<OverviewChange<R>>,
    options?: WriteOptions,
  ) => Promise<R | null>;
  /** 只关心一条记录时用它：读一条不读全部，库再大也只碰这一条。约定同 update，没有这条时 plan 拿到 null。 */
  readonly updateRecord: <R>(
    key: VideoKey,
    plan: (current: OverviewRecord | null) => OverviewChange<R> | Promise<OverviewChange<R>>,
    options?: WriteOptions,
  ) => Promise<R | null>;
}

function isValidOverview(record: OverviewRecord | undefined): record is OverviewRecord {
  return typeof record?.videoKey === "string" && parseVideoKey(record.videoKey) !== null;
}

function requireVideoKey(key: VideoKey): void {
  if (!parseVideoKey(String(key))) throw new Error("概览记录缺少 videoKey");
}

function buildRecord(
  { videoKey, title, author, analysisFailures }: OverviewFields,
  analysis: LearningAnalysis,
  updatedAt: number,
): OverviewRecord {
  const failures = normalizeAnalysisFailures(analysisFailures);
  return {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey,
    snapshot: { title: String(title || "").slice(0, TITLE_MAX), author: String(author || "").slice(0, AUTHOR_MAX) },
    analysis,
    updatedAt,
    ...(failures.length ? { analysisFailures: failures } : {}),
  };
}

export function createOverviewStore({ driver, guard, now = () => Date.now() }: OverviewStoreDeps): OverviewStore {
  const gate = createWriteGate(guard, "all");

  const readAll = async (): Promise<OverviewRecord[]> => (await driver.getAll()).filter(isValidOverview);

  const applyChange = ({ put = [], remove = [] }: OverviewChange): Promise<void> =>
    driver.write({ put: put.filter(isValidOverview), remove });

  async function put(record: OverviewRecord, { since }: WriteOptions = {}): Promise<boolean> {
    requireVideoKey(record.videoKey);
    const written = await gate(since, async () => {
      await driver.write({ put: [record] });
      return true;
    });
    return written === true;
  }

  const updateRecord: OverviewStore["updateRecord"] = (key, plan, { since } = {}) =>
    gate(since, async () => {
      const row = await driver.get(key);
      const change = await plan(isValidOverview(row) ? row : null);
      await applyChange(change);
      return change.result ?? null;
    });

  return {
    all: readAll,

    async find(key) {
      const row = await driver.get(key);
      return isValidOverview(row) ? row : null;
    },

    put,

    async save(input, { since, onlyIfMissing = false } = {}) {
      requireVideoKey(input.videoKey);
      const record = buildRecord(input, input.analysis, now());
      if (onlyIfMissing) {
        // 查有没有和写入在写队列里一次做完，中间插进来的新概览不会被这里盖掉。
        return updateRecord(
          input.videoKey,
          (current): OverviewChange<OverviewRecord> => (current ? {} : { put: [record], result: record }),
          { since },
        );
      }
      return (await put(record, { since })) ? record : null;
    },

    async updateAnalysis(fields, mutate, { since } = {}) {
      requireVideoKey(fields.videoKey);
      return updateRecord(
        fields.videoKey,
        (current): OverviewChange<OverviewRecord | null> => {
          const before = current?.analysis ?? null;
          const analysis = mutate(before);
          if (!analysis || analysis === before) return { result: current };
          const record = current ? { ...current, analysis, updatedAt: now() } : buildRecord(fields, analysis, now());
          return { put: [record], result: record };
        },
        { since },
      );
    },

    update(plan, { since } = {}) {
      return gate(since, async () => {
        const change = await plan(await readAll());
        await applyChange(change);
        return change.result ?? null;
      });
    },

    updateRecord,
  };
}
