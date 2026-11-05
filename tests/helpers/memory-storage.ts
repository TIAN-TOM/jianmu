// 扩展存储区的最小内存实现：读出的数据是拷贝，改动返回值不影响存储内容。
export interface MemoryStorage {
  readonly data: Record<string, unknown>;
  readonly get: (key?: string | readonly string[] | null) => Promise<Record<string, unknown>>;
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
  readonly remove: (key: string | readonly string[]) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export function memoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return structuredClone(data);
      const keys = typeof key === "string" ? [key] : key;
      const result: Record<string, unknown> = {};
      for (const item of keys) {
        if (item in data) result[item] = structuredClone(data[item]);
      }
      return result;
    },
    async set(entries) {
      Object.assign(data, structuredClone(entries));
    },
    async remove(key) {
      for (const item of typeof key === "string" ? [key] : key) delete data[item];
    },
    async clear() {
      for (const item of Object.keys(data)) delete data[item];
    },
  };
}
