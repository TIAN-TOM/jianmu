// Web Locks 的薄封装。扩展的页面和后台同源，同名的锁在它们之间是同一把。
// 拿着一把锁的时候不能再要同一把，否则自己等自己。

/** 只列用到的一种调用，真实的 Web Locks 和测试替身都按结构满足它。 */
export interface LockManagerLike {
  request<T>(name: string, options: { readonly mode: "exclusive" | "shared" }, work: () => T): Promise<Awaited<T>>;
}

export interface Locks {
  /** 独占：前面的都做完才开始，做完之前后来的都排队。 */
  readonly exclusive: <T>(name: string, work: () => T) => Promise<Awaited<T>>;
  /** 共享：同为共享的可以同时做，只和独占的互相排队。 */
  readonly shared: <T>(name: string, work: () => T) => Promise<Awaited<T>>;
}

export function createLocks(manager: LockManagerLike = navigator.locks): Locks {
  return {
    exclusive: (name, work) => manager.request(name, { mode: "exclusive" }, () => work()),
    shared: (name, work) => manager.request(name, { mode: "shared" }, () => work()),
  };
}
