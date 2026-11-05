// 并发控制：带上限的 map、串行队列、跨任务共享的并发闸门。
type Task<T> = () => T | PromiseLike<T>;

export type SerialQueue = <T>(task: Task<T>) => Promise<T>;

export interface LimiterOptions {
  readonly signal?: AbortSignal;
}

export type Limiter = <T>(limit: unknown, task: Task<T>, options?: LimiterOptions) => Promise<T>;

interface WaitingEntry {
  readonly cap: number;
  grant(): void;
}

/**
 * 带并发上限的 map，返回 allSettled 形状的结果。
 * 刻意保序（结果要按 id 对回分段）、单个失败不中断全局（一个限流不该丢整轮）。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: unknown,
  worker: (item: T, index: number) => R,
  onProgress?: (done: number, total: number) => void,
): Promise<PromiseSettledResult<Awaited<R>>[]> {
  const list: readonly T[] = Array.isArray(items) ? items : [];
  const total = list.length;
  const results = new Array<PromiseSettledResult<Awaited<R>>>(total);
  if (total === 0) return results;

  const size = Math.max(1, Math.min(Math.floor(Number(limit) || 1), total));
  let nextIndex = 0;
  let done = 0;

  const runOne = async (): Promise<void> => {
    while (true) {
      // 取号必须是同步的，不能 await 之后再取，否则多个 worker 会拿到同一个下标。
      const index = nextIndex;
      if (index >= total) return;
      nextIndex += 1;

      try {
        results[index] = { status: "fulfilled", value: await worker(list[index] as T, index) };
      } catch (error) {
        results[index] = { status: "rejected", reason: error };
      }

      done += 1;
      if (typeof onProgress === "function") {
        try {
          onProgress(done, total);
        } catch (error) {
          // 进度回调出错不该影响任务本身。
        }
      }
    }
  };

  await Promise.all(Array.from({ length: size }, runOne));
  return results;
}

/** 串行队列，保护「读—改—写」临界区：并发写时后写的会拿旧快照覆盖先写的。 */
export function createSerialQueue(): SerialQueue {
  let tail = Promise.resolve();

  return function enqueue<T>(task: Task<T>): Promise<T> {
    // 前一个任务失败不能让整条队列卡死，所以这里吞掉它的错误；
    // 错误本身由各自的调用方通过返回的 promise 收到。
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

function taskCanceledError(): Error & { code?: string } {
  const error: Error & { code?: string } = new Error("任务已取消。");
  error.code = "TASK_CANCELED";
  return error;
}

/**
 * 跨任务共享的并发闸门：几个视频同时生成概览时，发往模型的请求总数不超过上限。
 *
 * 上限由每次调用自己带进来，闸门不读设置。调用方传的是任务开始时读到的设置，
 * 所以设置页改了只对之后新开的任务生效；已在跑的任务仍按它开始时的上限取号。
 * 每个请求只在「在跑总数 < 它自己带的上限」时放行：调低上限后开的任务，
 * 要等在跑的请求降到新上限以下才轮得到。
 *
 * 排队按先来后到，队首放不行时后面的也不越过它。名额释放时当场（同步）
 * 判断要不要放队首进来，放行就直接把名额记到它头上：交接的空档里
 * 新来的调用看到名额已满，只能排队，插不了队。
 * 排队中的请求收到 signal 取消就立刻出队，以 TASK_CANCELED 结束，
 * 不必等别人让出名额。
 */
export function createLimiter(): Limiter {
  let active = 0;
  const waiting: WaitingEntry[] = [];

  const capOf = (limit: unknown): number => Math.max(1, Math.floor(Number(limit) || 1));

  function admit(): void {
    while (waiting.length && active < waiting[0]!.cap) {
      const entry = waiting.shift()!;
      active += 1;
      entry.grant();
    }
  }

  return async function run<T>(limit: unknown, task: Task<T>, { signal }: LimiterOptions = {}): Promise<T> {
    if (signal?.aborted) throw taskCanceledError();
    const cap = capOf(limit);
    if (!waiting.length && active < cap) {
      active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          const index = waiting.indexOf(entry);
          if (index === -1) return;
          waiting.splice(index, 1);
          reject(taskCanceledError());
          // 出队的可能是挡在前面的队首，后面的也许已经放得进去了。
          admit();
        };
        const entry: WaitingEntry = {
          cap,
          grant() {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        waiting.push(entry);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      active -= 1;
      admit();
    }
  };
}
