// 内存版 IndexedDB，让真实的驱动代码在 node --test 里走完整的事件链。只覆盖驱动用到的表面：
// 按版本升级、仓库和索引、事务的排队和回滚、连接的关闭和让出。
//
// 时序和浏览器一致：事件都异步派发；事务只在创建它的那一轮和请求回调里能发新请求；
// 请求全部落地后才提交；范围重叠的事务按开启顺序排队，读事务之间不互相挡。
import type {
  IdbDatabase,
  IdbFactory,
  IdbIndex,
  IdbKey,
  IdbObjectStore,
  IdbOpenRequest,
  IdbRequest,
  IdbTransaction,
} from "../../src/platform/idb.ts";

type Handler = ((event: never) => void) | null;
type Mode = "readonly" | "readwrite";
type FakeRequest<T> = IdbRequest<T> & { result: T; error: Error | null };
type OpenRequest = IdbOpenRequest & { result: IdbDatabase; error: Error | null; transaction: IdbTransaction | null };

interface StoreData {
  readonly keyPath: string;
  readonly indexes: Map<string, string>;
  rows: Map<IdbKey, unknown>;
}

interface Connection extends IdbDatabase {
  closed: boolean;
  upgrading: boolean;
}

interface PendingTransaction {
  readonly storeName: string;
  readonly mode: Mode;
  started: boolean;
  start(): void;
}

interface DatabaseData {
  version: number;
  readonly stores: Map<string, StoreData>;
  readonly connections: Set<Connection>;
  readonly transactions: PendingTransaction[]; // 开启顺序，已开始的在前
  readonly waiters: (() => void)[]; // 等连接关掉才能升级的请求
}

export interface StoreSnapshot {
  readonly keyPath: string;
  readonly indexes: Readonly<Record<string, string>>;
  readonly rows: readonly unknown[];
}

export interface MemoryIndexedDb extends IdbFactory {
  /** 让下一次打开失败，错误对象为空。 */
  readonly failNextOpen: () => void;
  /** 让后面第 skip + 1 个写请求以指定错误失败，模拟配额满、读写出错。 */
  readonly failNextWrite: (error: Error, options?: { readonly skip?: number }) => void;
  /** 调用过几次 open，失败的也算。 */
  readonly openCount: () => number;
  /** 现在还开着几个连接。 */
  readonly openConnections: () => number;
  /** 在已经关掉的连接上开过几次事务。 */
  readonly staleTransactions: () => number;
  /** 浏览器异常关掉全部连接。fireOnclose 为 false 时只关不发 close 事件。 */
  readonly closeConnections: (options?: { readonly fireOnclose?: boolean }) => void;
  /** 当前的版本号和结构，没建过库时是 undefined。 */
  readonly inspect: (name: string) => { readonly version: number; readonly stores: Record<string, StoreSnapshot> } | undefined;
}

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function keyRank(key: IdbKey): number {
  return typeof key === "number" ? 0 : 1;
}

/** 键的排序：数字在字符串前面，同类按大小，和 IndexedDB 一致。 */
export function compareKeys(left: IdbKey, right: IdbKey): number {
  if (keyRank(left) !== keyRank(right)) return keyRank(left) - keyRank(right);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 从记录里取键，取不到合法的键时是 undefined。 */
export function readKey(record: unknown, keyPath: string): IdbKey | undefined {
  const value = (record as Record<string, unknown> | null | undefined)?.[keyPath];
  return typeof value === "string" || (typeof value === "number" && !Number.isNaN(value)) ? value : undefined;
}

function sortedRows(rows: Map<IdbKey, unknown>): unknown[] {
  return [...rows.entries()].sort(([left], [right]) => compareKeys(left, right)).map(([, row]) => structuredClone(row));
}

function indexedRows(store: StoreData, keyPath: string, key: IdbKey | undefined): unknown[] {
  const hits: { indexKey: IdbKey; primary: IdbKey; row: unknown }[] = [];
  for (const [primary, row] of store.rows) {
    const indexKey = readKey(row, keyPath);
    if (indexKey === undefined || (key !== undefined && indexKey !== key)) continue;
    hits.push({ indexKey, primary, row });
  }
  hits.sort((left, right) => compareKeys(left.indexKey, right.indexKey) || compareKeys(left.primary, right.primary));
  return hits.map(({ row }) => structuredClone(row));
}

function createRequest<T>(): FakeRequest<T> {
  return { result: undefined as T, error: null, onsuccess: null, onerror: null };
}

function fire(handler: Handler, event: unknown = {}): void {
  (handler as ((event: unknown) => void) | null)?.(event);
}

export function createMemoryIndexedDb(): MemoryIndexedDb {
  const databases = new Map<string, DatabaseData>();
  const connections: Connection[] = [];
  let openCalls = 0;
  let staleTransactions = 0;
  let openFailures = 0;
  let writeFailure: { error: Error; skip: number } | null = null;

  function takeWriteFailure(): Error | null {
    if (!writeFailure) return null;
    if (writeFailure.skip > 0) {
      writeFailure.skip -= 1;
      return null;
    }
    const { error } = writeFailure;
    writeFailure = null;
    return error;
  }

  function databaseFor(name: string): DatabaseData {
    const existing = databases.get(name);
    if (existing) return existing;
    const created: DatabaseData = { version: 0, stores: new Map(), connections: new Set(), transactions: [], waiters: [] };
    databases.set(name, created);
    return created;
  }

  function pump(data: DatabaseData): void {
    const earlier: PendingTransaction[] = [];
    for (const tx of data.transactions) {
      const blocked = earlier.some(
        (other) => other.storeName === tx.storeName && (other.mode === "readwrite" || tx.mode === "readwrite"),
      );
      if (!tx.started && !blocked) tx.start();
      earlier.push(tx);
    }
  }

  function createTransaction(data: DatabaseData, storeName: string, mode: Mode, store: StoreData): IdbTransaction {
    const requests: { run: () => unknown; request: FakeRequest<unknown>; writes: boolean }[] = [];
    let active = true;
    let finished = false;
    let snapshot: Map<IdbKey, unknown> | null = null;

    function settle(): void {
      const position = data.transactions.indexOf(entry);
      if (position >= 0) data.transactions.splice(position, 1);
      pump(data);
    }

    function complete(): void {
      finished = true;
      setImmediate(() => {
        fire(tx.oncomplete);
        settle();
      });
    }

    function abort(error: Error | null): void {
      finished = true;
      tx.error = error;
      if (snapshot) store.rows = snapshot;
      const pending = requests.splice(0);
      setImmediate(() => {
        for (const { request } of pending) {
          request.error = named("AbortError", "事务已中止");
          fire(request.onerror);
        }
        fire(tx.onabort);
        settle();
      });
    }

    function tick(): void {
      active = false;
      if (finished) return;
      const next = requests.shift();
      if (!next) {
        complete();
        return;
      }
      const failure = next.writes ? takeWriteFailure() : null;
      if (failure) {
        next.request.error = failure;
        fire(next.request.onerror);
        // 事件冒泡到事务时事务的 error 还是空的，派发完才中止并写上。
        fire(tx.onerror);
        abort(failure);
        return;
      }
      next.request.result = next.run();
      active = true;
      fire(next.request.onsuccess);
      setImmediate(tick);
    }

    const entry: PendingTransaction = {
      storeName,
      mode,
      started: false,
      start() {
        entry.started = true;
        if (mode === "readwrite") snapshot = new Map(store.rows);
        setImmediate(tick);
      },
    };

    function place<T>(writes: boolean, run: () => T): IdbRequest<T> {
      if (finished || !active) throw named("TransactionInactiveError", "事务已经不接受新请求");
      if (writes && mode === "readonly") throw named("ReadOnlyError", "只读事务不能写入");
      const request = createRequest<T>();
      requests.push({ run, request: request as FakeRequest<unknown>, writes });
      return request;
    }

    const objectStore: IdbObjectStore = {
      get: (key) => place(false, () => structuredClone(store.rows.get(key))),
      getAll: () => place(false, () => sortedRows(store.rows)),
      put(record) {
        // 浏览器在 put 这一下就克隆并取键，克隆不了或没有主键时同步抛错。
        const copy = structuredClone(record);
        const key = readKey(copy, store.keyPath);
        if (key === undefined) throw named("DataError", `记录没有主键 ${store.keyPath}`);
        return place(true, () => {
          store.rows.set(key, copy);
          return key;
        });
      },
      delete: (key) => place(true, () => void store.rows.delete(key)),
      clear: () => place(true, () => void store.rows.clear()),
      index(name): IdbIndex {
        const keyPath = store.indexes.get(name);
        if (keyPath === undefined) throw named("NotFoundError", `没有名为 ${name} 的索引`);
        return { getAll: (key) => place(false, () => indexedRows(store, keyPath, key)) };
      },
      createIndex() {
        throw named("InvalidStateError", "只有升级事务能建索引");
      },
    };

    const tx: IdbTransaction & { error: Error | null; onerror: Handler } = {
      error: null,
      oncomplete: null,
      onabort: null,
      onerror: null,
      objectStore: () => objectStore,
      abort() {
        if (finished) throw named("InvalidStateError", "事务已经结束");
        abort(named("AbortError", "事务已中止"));
      },
    };

    data.transactions.push(entry);
    pump(data);
    // 创建它的这一轮过去以后，新请求只能在请求回调里发。
    setImmediate(() => {
      if (!entry.started) active = false;
    });
    return tx;
  }

  function createConnection(data: DatabaseData): Connection {
    const connection: Connection = {
      closed: false,
      upgrading: false,
      onclose: null,
      onversionchange: null,
      close() {
        connection.closed = true;
        data.connections.delete(connection);
        if (data.connections.size === 0) for (const resume of data.waiters.splice(0)) resume();
      },
      createObjectStore(name, { keyPath }) {
        if (!connection.upgrading) throw named("InvalidStateError", "只有升级事务能建仓库");
        if (data.stores.has(name)) throw named("ConstraintError", `对象仓库已存在：${name}`);
        const store: StoreData = { keyPath, indexes: new Map(), rows: new Map() };
        data.stores.set(name, store);
        return upgradeStore(store);
      },
      transaction(storeName, mode) {
        // 和浏览器一样：连接已经关掉时同步抛 InvalidStateError。
        if (connection.closed) {
          staleTransactions += 1;
          throw named("InvalidStateError", "The database connection is closing.");
        }
        const store = data.stores.get(storeName);
        if (!store) throw named("NotFoundError", `没有名为 ${storeName} 的对象仓库`);
        return createTransaction(data, storeName, mode, store);
      },
    };
    data.connections.add(connection);
    connections.push(connection);
    return connection;
  }

  function upgradeStore(store: StoreData): IdbObjectStore {
    const unavailable = (): never => {
      throw named("InvalidStateError", "这个替身的升级事务只支持建仓库和索引");
    };
    return {
      get: unavailable,
      getAll: unavailable,
      put: unavailable,
      delete: unavailable,
      clear: unavailable,
      index: unavailable,
      createIndex(name, keyPath) {
        if (store.indexes.has(name)) throw named("ConstraintError", `索引已存在：${name}`);
        store.indexes.set(name, keyPath);
      },
    };
  }

  function upgrade(data: DatabaseData, request: OpenRequest, version: number): void {
    const oldVersion = data.version;
    const before = [...data.stores].map(([name, store]) => [name, { ...store, indexes: new Map(store.indexes) }] as const);
    const connection = createConnection(data);
    connection.upgrading = true;
    request.result = connection;
    request.transaction = {
      error: null,
      oncomplete: null,
      onabort: null,
      objectStore(name) {
        const store = data.stores.get(name);
        if (!store) throw named("NotFoundError", `没有名为 ${name} 的对象仓库`);
        return upgradeStore(store);
      },
      abort: () => {},
    };
    data.version = version;
    try {
      fire(request.onupgradeneeded, { oldVersion, newVersion: version });
      connection.upgrading = false;
      request.transaction = null;
      fire(request.onsuccess);
    } catch {
      // 升级处理函数抛错时事务中止，版本和结构都退回去。
      data.version = oldVersion;
      data.stores.clear();
      for (const [name, store] of before) data.stores.set(name, store);
      connection.close();
      request.transaction = null;
      request.error = named("AbortError", "升级已中止");
      fire(request.onerror);
    }
  }

  function openDatabase(name: string, version: number, request: OpenRequest): void {
    if (openFailures > 0) {
      openFailures -= 1;
      fire(request.onerror);
      return;
    }
    const data = databaseFor(name);
    if (version < data.version) {
      request.error = named("VersionError", "数据库的版本比请求的新");
      fire(request.onerror);
      return;
    }
    if (version === data.version) {
      request.result = createConnection(data);
      fire(request.onsuccess);
      return;
    }
    for (const connection of [...data.connections]) {
      fire(connection.onversionchange, { oldVersion: data.version, newVersion: version });
    }
    if (data.connections.size === 0) {
      upgrade(data, request, version);
      return;
    }
    fire(request.onblocked);
    data.waiters.push(() => upgrade(data, request, version));
  }

  return {
    open(name, version) {
      const request: OpenRequest = {
        ...createRequest<IdbDatabase>(),
        transaction: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      openCalls += 1;
      setImmediate(() => openDatabase(name, version, request));
      return request;
    },
    failNextOpen() {
      openFailures += 1;
    },
    failNextWrite(error, { skip = 0 } = {}) {
      writeFailure = { error, skip };
    },
    openCount: () => openCalls,
    openConnections: () => connections.filter((connection) => !connection.closed).length,
    staleTransactions: () => staleTransactions,
    closeConnections({ fireOnclose = true } = {}) {
      for (const connection of connections) {
        if (connection.closed) continue;
        connection.close();
        if (fireOnclose) fire(connection.onclose);
      }
    },
    inspect(name) {
      const data = databases.get(name);
      if (!data) return undefined;
      const stores: Record<string, StoreSnapshot> = {};
      for (const [storeName, store] of data.stores) {
        stores[storeName] = { keyPath: store.keyPath, indexes: Object.fromEntries(store.indexes), rows: sortedRows(store.rows) };
      }
      return { version: data.version, stores };
    },
  };
}
