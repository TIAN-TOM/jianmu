// IndexedDB 的底层驱动：一个数据库，多个对象仓库。只有后台打开它，页面都经消息读写。
// 驱动只管按主键和索引存取一批记录，每次返回数据的拷贝；写入的串行队列和清除闸门在调用它的仓储里。
import { DATABASE_NAME, STORE_NAMES, type StoreName } from "../shared/names.ts";

// 下面的接口只列驱动用到的那一小块，真实的 IndexedDB 和测试替身都按结构满足它们。
// 事件处理函数写成方法签名，参数按双向比较，真实的事件类型才能赋给这里的窄类型。
type Listener<E = unknown> = { handle(event: E): void }["handle"];

export type IdbKey = string | number;

export interface IdbRequest<T> {
  readonly result: T;
  readonly error: Error | null;
  onsuccess: Listener | null;
  onerror: Listener | null;
}

export interface IdbIndex {
  getAll(key?: IdbKey): IdbRequest<unknown[]>;
}

export interface IdbObjectStore {
  get(key: IdbKey): IdbRequest<unknown>;
  getAll(): IdbRequest<unknown[]>;
  put(record: unknown): unknown;
  delete(key: IdbKey): unknown;
  clear(): IdbRequest<undefined>;
  index(name: string): IdbIndex;
  createIndex(name: string, keyPath: string): unknown;
}

export interface IdbTransaction {
  readonly error: Error | null;
  oncomplete: Listener | null;
  onabort: Listener | null;
  objectStore(name: string): IdbObjectStore;
  abort(): void;
}

export interface IdbDatabase {
  onclose: Listener | null;
  onversionchange: Listener | null;
  close(): void;
  createObjectStore(name: string, options: { keyPath: string }): IdbObjectStore;
  transaction(storeName: string, mode: "readonly" | "readwrite"): IdbTransaction;
}

export interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  readonly transaction: IdbTransaction | null;
  onupgradeneeded: Listener<{ readonly oldVersion: number }> | null;
  onblocked: Listener | null;
}

export interface IdbFactory {
  open(name: string, version: number): IdbOpenRequest;
}

export interface StoreSchema {
  readonly keyPath: string;
  readonly indexes: Readonly<Record<string, string>>;
}

// 第 1 版的结构，只给第 1 步用，不跟着 STORE_NAMES 变：发布以后这张表不再改，
// 新仓库和新索引都写进后面的步骤，否则全新安装会在后面的步骤里重复创建而失败。
// translations 的 id 由访问层用字幕版本加目标语言拼出来。
// 记录缺少索引字段时不进索引，也不报错，所以字段名要和记录类型一致。
export const FIRST_VERSION_STORES = {
  notes: { keyPath: "id", indexes: { byVideo: "video", byCreated: "createdAt" } },
  overviews: { keyPath: "videoKey", indexes: { byUpdated: "updatedAt" } },
  qa: { keyPath: "id", indexes: { byVideo: "video", byCreated: "createdAt" } },
  cache: { keyPath: "videoKey", indexes: { byTimestamp: "timestamp" } },
  translations: { keyPath: "id", indexes: { byVideo: "video" } },
  imports: { keyPath: "videoKey", indexes: {} },
  channels: { keyPath: "channelKey", indexes: {} },
} as const satisfies Record<string, StoreSchema>;

export type UpgradeStep = (db: IdbDatabase, tx: IdbTransaction) => void;

const createFirstVersion: UpgradeStep = (db) => {
  for (const [name, { keyPath, indexes }] of Object.entries<StoreSchema>(FIRST_VERSION_STORES)) {
    const store = db.createObjectStore(name, { keyPath });
    for (const [index, path] of Object.entries(indexes)) store.createIndex(index, path);
  }
};

// 第 N 项把数据库从第 N - 1 版升到第 N 版，版本号就是步数。已有的步骤不改，只往后加。
export const UPGRADE_STEPS: readonly UpgradeStep[] = [createFirstVersion];
export const DATABASE_VERSION = UPGRADE_STEPS.length;

export interface StoreChange<T> {
  readonly put?: readonly T[];
  readonly remove?: readonly IdbKey[];
}

export interface ObjectStoreDriver<T> {
  readonly getAll: () => Promise<T[]>;
  readonly get: (key: IdbKey) => Promise<T | undefined>;
  /** 按索引取，结果按索引值排序。不给 key 就取全部，用来按时间排。 */
  readonly getAllByIndex: (index: string, key?: IdbKey) => Promise<T[]>;
  /** 清空这个仓库。 */
  readonly clear: () => Promise<void>;
  /** 关掉连接，关完再调用会重新打开。 */
  readonly close: () => void;
  /** 单个读写事务内完成全部写入：要么全部落地，要么全部回滚。 */
  readonly write: (change?: StoreChange<T>) => Promise<void>;
}

export interface DriverOptions {
  readonly storeName: StoreName;
  // 调用方显式传入，不默认读全局，测试才能换替身。
  readonly indexedDB: IdbFactory | undefined;
  readonly databaseName?: string;
  readonly steps?: readonly UpgradeStep[];
}

function promisifyRequest<T>(request: IdbRequest<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`IndexedDB 请求失败：${label}`));
  });
}

export function createObjectStoreDriver<T>({
  storeName,
  indexedDB,
  databaseName = DATABASE_NAME,
  steps = UPGRADE_STEPS,
}: DriverOptions): ObjectStoreDriver<T> {
  if (!STORE_NAMES.includes(storeName)) throw new Error(`未登记的对象仓库：${storeName}`);
  if (!indexedDB) throw new Error("当前环境没有 IndexedDB 可用");
  const factory = indexedDB;

  let opening: Promise<IdbDatabase> | null = null;

  function openDatabase(): Promise<IdbDatabase> {
    if (opening) return opening;
    const current = new Promise<IdbDatabase>((resolve, reject) => {
      let abandoned = false;
      const forget = (): void => {
        if (opening === current) opening = null;
      };
      const request = factory.open(databaseName, steps.length);
      request.onupgradeneeded = ({ oldVersion }) => {
        for (const step of steps.slice(oldVersion)) step(request.result, request.transaction!);
      };
      request.onsuccess = () => {
        const db = request.result;
        // 被挡住时已经报过错，打开请求却取消不了，迟到的连接没人持有，直接关掉。
        if (abandoned) {
          db.close();
          return;
        }
        // 浏览器异常关掉连接（存储出错、开发者工具里清了数据）后，这个连接再也开不了事务：
        // 作废缓存，下次调用重新打开，而不是一直复用到 worker 重启。
        db.onclose = forget;
        // 别处要升级数据库：让出连接，免得挡住升级。
        db.onversionchange = () => {
          db.close();
          forget();
        };
        resolve(db);
      };
      request.onerror = () => {
        // 一次瞬时失败（磁盘忙、连接中断）不该毒化整个生命周期：下一次调用重新打开。
        forget();
        reject(request.error ?? new Error("IndexedDB 打开失败"));
      };
      request.onblocked = () => {
        // 升级被其他连接挡住时这个请求一直不落定，明确失败，上层才能提示用户。
        abandoned = true;
        forget();
        reject(new Error("IndexedDB 正被其他窗口占用，请稍后重试"));
      };
    });
    opening = current;
    return current;
  }

  // close 事件没赶上时，缓存的连接已经关了：开事务抛 InvalidStateError，作废重开一次。
  async function openTransaction(mode: "readonly" | "readwrite"): Promise<IdbTransaction> {
    const failed = openDatabase();
    const db = await failed;
    try {
      return db.transaction(storeName, mode);
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== "InvalidStateError") throw error;
      // 只作废断掉的这条连接，并发的操作共用同一次重开。
      if (opening === failed) opening = null;
      return (await openDatabase()).transaction(storeName, mode);
    }
  }

  async function withTransaction<R>(
    mode: "readonly" | "readwrite",
    run: (store: IdbObjectStore) => R | Promise<R>,
  ): Promise<R> {
    const tx = await openTransaction(mode);
    const store = tx.objectStore(storeName);
    try {
      const result = await run(store);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        // 请求失败的 error 事件冒泡到事务时，事务的 error 还没写上，紧跟着的 abort 事件才带原始错误。
        tx.onabort = () => reject(tx.error ?? new Error("事务已中止"));
      });
      return result;
    } catch (error) {
      // run 抛错时事务可能还挂着未决请求，abort 让浏览器立刻收尾；
      // 事务已自行结束时 abort 会抛错，吞掉即可。
      try {
        tx.abort();
      } catch {}
      throw error;
    }
  }

  return {
    async getAll() {
      return withTransaction("readonly", (store) => promisifyRequest(store.getAll() as IdbRequest<T[]>, "getAll"));
    },
    async get(key) {
      return withTransaction("readonly", (store) =>
        promisifyRequest(store.get(key) as IdbRequest<T | undefined>, "get"),
      );
    },
    async getAllByIndex(index, key) {
      return withTransaction("readonly", (store) =>
        promisifyRequest(store.index(index).getAll(key) as IdbRequest<T[]>, "getAllByIndex"),
      );
    },
    async clear() {
      await withTransaction("readwrite", (store) => promisifyRequest(store.clear(), "clear"));
    },
    close() {
      const pending = opening;
      opening = null;
      pending?.then((db) => db.close()).catch(() => {});
    },
    async write({ put = [], remove = [] } = {}) {
      if (!put.length && !remove.length) return;
      await withTransaction("readwrite", (store) => {
        for (const record of put) store.put(record);
        for (const key of remove) store.delete(key);
      });
    },
  };
}
