/// <reference types="chrome" />
// chrome.storage 的薄封装。下面的接口只列用到的方法，真实的存储区和测试替身都按结构满足它们。

export interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ExtensionStorage {
  readonly local: StorageArea;
  readonly session: StorageArea;
}

/** 浏览器的两个存储区。session 留在内存里不写磁盘，默认只有扩展页面和后台读得到。 */
export function extensionStorage(): ExtensionStorage {
  return { local: chrome.storage.local, session: chrome.storage.session };
}

/** 读一项，没有时是 undefined。 */
export async function readItem(area: StorageArea, key: string): Promise<unknown> {
  return (await area.get(key))[key];
}
