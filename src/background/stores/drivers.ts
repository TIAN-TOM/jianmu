// 数据库仓库的驱动按需建：第一次读写时才建、才开库。后台醒来时不碰数据库，
// 没有数据库的环境里也能把后台拼起来，用到仓储时才报错。
import { createObjectStoreDriver, type IdbFactory, type ObjectStoreDriver } from "../../platform/idb.ts";
import type { StoreName } from "../../shared/names.ts";

export function lazyDriver<T>(storeName: StoreName, indexedDB: () => IdbFactory | undefined): ObjectStoreDriver<T> {
  let driver: ObjectStoreDriver<T> | undefined;
  const current = (): ObjectStoreDriver<T> => (driver ??= createObjectStoreDriver<T>({ storeName, indexedDB: indexedDB() }));
  return {
    getAll: () => current().getAll(),
    get: (key) => current().get(key),
    getAllByIndex: (index, key) => current().getAllByIndex(index, key),
    clear: () => current().clear(),
    close: () => driver?.close(),
    write: (change) => current().write(change),
  };
}
