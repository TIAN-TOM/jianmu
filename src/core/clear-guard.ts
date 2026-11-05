// 「清除本机数据」和本机写入之间的闸门。
export type ClearScope = "cache" | "all";

export interface ClearEpoch {
  readonly cache: number;
  readonly all: number;
}

export interface ClearGuard {
  readonly epoch: () => ClearEpoch | undefined;
  readonly clearedSince: (since: ClearEpoch | undefined, scope?: ClearScope) => boolean;
  readonly track: <T>(write: () => T | PromiseLike<T>) => Promise<T>;
  readonly clear: <T>(scope: ClearScope, run: () => T | PromiseLike<T>) => Promise<T>;
}

/**
 * 「清除本机数据」和本机写入之间的一道闸。
 *
 * 清除之前就开始的操作（保存笔记、存问答、读稍后再看列表、导入备份……），往往要先等网络
 * 或模型，回来时数据可能已经清掉了。只在操作开头查一次不够：它回来写的那一下会把刚清掉的
 * 记录又写回去。这里的约定是：
 * - 操作开头用 epoch() 记下当时的清除代数；
 * - 真正写的那一段放进 track()，在里面用 clearedSince() 再查一次，清过了就不写；
 * - clear() 先把代数加一，再等已经进了 track() 的写入做完，然后才清。
 *   查和写都在 track() 里，所以一次写入要么在清除之前写完（随后被清掉），要么看到新代数不写；
 * - 清除进行中才进来的写入先等清除做完，再照常写：那是清除之后的新操作，应当留下。
 *
 * 「清除缓存」只清字幕缓存和粗筛这类能重新取回的数据，笔记、概览、问答都还在，所以分两个代数：
 * 两种清除都让 cache 代数加一，只有「清除全部数据」让 all 代数加一。
 * track() 里不能再套 track()：清除进行中，里面那层会等清除，清除又在等外面那层。
 */
export function createClearGuard(): ClearGuard {
  let cacheEpoch = 0;
  let allEpoch = 0;
  const inFlight = new Set<Promise<unknown>>();
  let clearing: Promise<void> | null = null;

  function epoch(): ClearEpoch {
    return { cache: cacheEpoch, all: allEpoch };
  }

  // since 是 epoch() 的返回值；没有记的（undefined）一律当作没清过。
  function clearedSince(since: ClearEpoch | undefined, scope: ClearScope = "all"): boolean {
    if (!since) return false;
    return scope === "cache" ? since.cache !== cacheEpoch : since.all !== allEpoch;
  }

  async function track<T>(write: () => T | PromiseLike<T>): Promise<T> {
    while (clearing) await clearing;
    // 登记必须和上面的检查在同一个同步段里，清除才等得到它。
    const running = Promise.resolve().then(write);
    inFlight.add(running);
    try {
      return await running;
    } finally {
      inFlight.delete(running);
    }
  }

  async function clear<T>(scope: ClearScope, run: () => T | PromiseLike<T>): Promise<T> {
    while (clearing) await clearing;
    cacheEpoch += 1;
    if (scope === "all") allEpoch += 1;
    // Promise 的执行函数同步运行，下面用到时一定已赋值。
    let finish!: () => void;
    clearing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await Promise.allSettled([...inFlight]);
      return await run();
    } finally {
      clearing = null;
      finish();
    }
  }

  return { epoch, clearedSince, track, clear };
}

// 测试和没接闸门的调用方用：从不算清过，写入照常执行。
export const NO_CLEAR_GUARD: ClearGuard = Object.freeze({
  epoch: () => undefined,
  clearedSince: () => false,
  track: <T>(write: () => T | PromiseLike<T>) => Promise.resolve().then(write),
  clear: <T>(scope: ClearScope, run: () => T | PromiseLike<T>) => Promise.resolve().then(run),
});
