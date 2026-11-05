// 由测试决定什么时候放行的 promise，用来把异步操作停在要观察的那一步。
export interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 让已经就绪的微任务都跑完，用来确认某件事没有发生。 */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
