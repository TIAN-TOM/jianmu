// 驱动接口的内存实现，主键和索引取自真实的仓库结构，给仓储和服务的测试用。
// 和 IndexedDB 一样，每次读写都是拷贝，改动返回值不影响库内内容。
import { FIRST_VERSION_STORES, type IdbKey, type ObjectStoreDriver, type StoreSchema } from "../../src/platform/idb.ts";
import type { StoreName } from "../../src/shared/names.ts";
import { compareKeys, readKey } from "./memory-idb.ts";

export function createMemoryDriver<T>(storeName: StoreName, initialRecords: readonly T[] = []): ObjectStoreDriver<T> {
  const { keyPath, indexes }: StoreSchema = FIRST_VERSION_STORES[storeName];
  const rows = new Map<IdbKey, T>();

  function keyOf(record: T): IdbKey {
    const key = readKey(record, keyPath);
    if (key === undefined) throw new TypeError(`记录没有主键 ${keyPath}`);
    return key;
  }

  for (const record of initialRecords) {
    if (readKey(record, keyPath) !== undefined) rows.set(keyOf(record), structuredClone(record));
  }

  return {
    async getAll() {
      return [...rows.entries()]
        .sort(([left], [right]) => compareKeys(left, right))
        .map(([, record]) => structuredClone(record));
    },
    async get(key) {
      return rows.has(key) ? structuredClone(rows.get(key)) : undefined;
    },
    async getAllByIndex(index, key) {
      const path = indexes[index];
      if (path === undefined) throw new Error(`没有名为 ${index} 的索引`);
      const hits: { indexKey: IdbKey; primary: IdbKey; record: T }[] = [];
      for (const [primary, record] of rows) {
        const indexKey = readKey(record, path);
        if (indexKey !== undefined && (key === undefined || indexKey === key)) hits.push({ indexKey, primary, record });
      }
      return hits
        .sort((left, right) => compareKeys(left.indexKey, right.indexKey) || compareKeys(left.primary, right.primary))
        .map(({ record }) => structuredClone(record));
    },
    async clear() {
      rows.clear();
    },
    close() {},
    async write({ put = [], remove = [] } = {}) {
      const keyed = put.map((record) => [keyOf(record), structuredClone(record)] as const);
      for (const [key, record] of keyed) rows.set(key, record);
      for (const key of remove) rows.delete(key);
    },
  };
}
