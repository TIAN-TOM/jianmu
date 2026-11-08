/// <reference types="chrome" />
// chrome.storage 的薄封装。下面的接口只列用到的方法，真实的存储区和测试替身都按结构满足它们。

export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface RestrictableStorageArea extends StorageArea {
  setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
}

export interface ExtensionStorage {
  readonly local: RestrictableStorageArea;
  readonly session: StorageArea;
}

/** 浏览器的两个存储区。session 留在内存里不写磁盘，默认只有扩展页面和后台读得到。 */
export function extensionStorage(): ExtensionStorage {
  return { local: chrome.storage.local, session: chrome.storage.session };
}

/**
 * 限制成只有扩展页面和后台读得到。这只挡内容脚本，不是加密。
 * 浏览器没有这个方法，或者这个版本还不能限制 storage.local 时抛错，调用方不能接着写密钥。
 */
export async function restrictToTrustedContexts(area: RestrictableStorageArea): Promise<void> {
  if (!area.setAccessLevel) throw new Error("这个浏览器不能限制存储区的访问");
  await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

/**
 * 存储写满的报错。浏览器的文案随版本变，有的带存储区的配额名，有的带内部资源名，
 * 只认其中一种会漏掉另一种，所以按共同的「quota」判断。
 */
export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && /quota/i.test(error.message);
}

/** 读一项，没有时是 undefined。 */
export async function readItem(area: StorageArea, key: string): Promise<unknown> {
  return (await area.get(key))[key];
}
