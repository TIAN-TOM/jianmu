// 字幕缓存：视频信息、字幕、官方总结这类能重新取回的数据，一个视频一条，过期和超量的自动淘汰。
// 缓存出问题不挡主流程：读不出来当作没有，写不进去回 false。
import type { ClearGuard } from "../../core/clear-guard.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 60;

export type CacheEntry<T extends object> = T & {
  readonly videoKey: VideoKey;
  readonly timestamp: number;
};

export interface CacheSaveOptions extends WriteOptions {
  // 只改已有条目时关掉：淘汰要读全量缓存，一次任务几十批经不起这么读。
  readonly evict?: boolean;
}

export interface CacheStoreDeps<T extends object> {
  readonly driver: ObjectStoreDriver<CacheEntry<T>>;
  readonly guard: ClearGuard;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

export interface CacheStore<T extends object> {
  readonly load: (key: VideoKey) => Promise<CacheEntry<T> | null>;
  readonly save: (key: VideoKey, data: T, options?: CacheSaveOptions) => Promise<boolean>;
  /**
   * 读—改—写一次做完。mutate 拿到现读的条目，过期或没有时是 null；交回 null 或原样交回表示不写。
   * 返回写入后的条目，没写时返回现有的。清除过就不调用 mutate，返回 null。写不进去时抛错。
   */
  readonly update: (
    key: VideoKey,
    mutate: (current: CacheEntry<T> | null) => T | null,
    options?: WriteOptions,
  ) => Promise<CacheEntry<T> | null>;
  /** 先清过期的，再按写入时间淘汰最旧的，把总量压回上限，返回删掉的键。 */
  readonly evict: () => Promise<VideoKey[]>;
  readonly remove: (key: VideoKey, options?: WriteOptions) => Promise<void>;
}

export function createCacheStore<T extends object>({
  driver,
  guard,
  now = () => Date.now(),
  maxEntries = CACHE_MAX_ENTRIES,
}: CacheStoreDeps<T>): CacheStore<T> {
  const gate = createWriteGate(guard, "cache");

  const isExpired = (entry: CacheEntry<T>, at: number): boolean => at - entry.timestamp > CACHE_TTL_MS;

  async function sweep(): Promise<VideoKey[]> {
    try {
      const at = now();
      const rows = await driver.getAllByIndex("byTimestamp");
      const expired = rows.filter((row) => isExpired(row, at));
      const fresh = rows.filter((row) => !isExpired(row, at));
      const stale = fresh.slice(0, Math.max(0, fresh.length - maxEntries));
      const removals = [...expired, ...stale].map((row) => row.videoKey);
      if (removals.length) await driver.write({ remove: removals });
      return removals;
    } catch (error) {
      console.error("清理缓存失败", error);
      return [];
    }
  }

  return {
    async load(key) {
      try {
        const cached = await driver.get(key);
        if (!cached) return null;
        if (!isExpired(cached, now())) return cached;
        await gate(undefined, async () => {
          // 排队的工夫这条可能刚被写新，删之前再读一次。
          const row = await driver.get(key);
          if (row && isExpired(row, now())) await driver.write({ remove: [key] });
        });
        return null;
      } catch (error) {
        console.error("读取缓存失败", error);
        return null;
      }
    },

    async save(key, data, { since, evict = true } = {}) {
      try {
        const written = await gate(since, async () => {
          await driver.write({ put: [{ ...data, videoKey: key, timestamp: now() }] });
          if (evict) await sweep();
          return true;
        });
        return written === true;
      } catch (error) {
        console.error("写入缓存失败", error);
        return false;
      }
    },

    update(key, mutate, { since } = {}) {
      return gate(since, async () => {
        const row = await driver.get(key);
        const current = row && !isExpired(row, now()) ? row : null;
        const next = mutate(current);
        if (next === null || next === current) return current;
        const entry: CacheEntry<T> = { ...next, videoKey: key, timestamp: now() };
        await driver.write({ put: [entry] });
        return entry;
      });
    },

    async evict() {
      return (await gate(undefined, sweep)) ?? [];
    },

    async remove(key, { since } = {}) {
      await gate(since, () => driver.write({ remove: [key] }));
    },
  };
}
