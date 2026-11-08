/// <reference types="chrome" />
// 任务在跑时的 service worker 保活。

export interface KeepAliveDeps {
  readonly ping: () => unknown;
  readonly intervalMs?: number;
  readonly now?: () => number;
  // 计时器句柄的类型各环境不同，这里只原样交回 clearTimeout；写成方法才放得进具体的句柄类型。
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?(timer: unknown): void;
}

export interface KeepAlive {
  hold(budgetMs: number): () => void;
  during<Result>(budgetMs: number, work: () => Result | Promise<Result>): Promise<Result>;
}

/** 浏览器里的保活调用：任何扩展接口都行，挑一个没有副作用的。 */
export const chromePing = (): Promise<unknown> => chrome.runtime.getPlatformInfo();

/**
 * 一份保活的上限：一次模型调用最长能拖多久。传输层每轮最多一个硬超时，最多 3 轮；参数被拒后的放宽重发不占轮次，
 * 另留一轮；限流或过载时等一会儿再重发一次，也不占轮次，再留一轮；再加一分钟余量。关和低档算出来是 11 分钟。
 */
export function keepAliveBudget(timeoutMs: number): number {
  return timeoutMs * 5 + 60_000;
}

/**
 * MV3 的 service worker 空闲约 30 秒就会被回收，在途的 fetch 跟着中止：发起任务的页面关掉以后，
 * 没有挂着的消息撑着它；页面开着，挂着的消息也只撑 5 分钟左右。
 * 调用任何扩展 API 都会重置空闲计时，所以有任务在跑时每隔 intervalMs 调一次 ping。
 *
 * hold(budgetMs) 登记一份保活，返回 release()；任务结束时调用，最后一份撤掉就立刻停表。
 * 每份登记各有截止时间（登记时刻 + budgetMs），全都过了也停：任务因为意外一直不结束，
 * 也不能让 worker 永远不休眠。during(budgetMs, work) 是 hold 加 release 的简写。
 */
export function createKeepAlive({
  ping,
  intervalMs = 20 * 1000,
  now = () => Date.now(),
  // 计时器可由调用方传入，测试用手动推进的替身。
  setTimeout: schedule = setTimeout,
  clearTimeout: unschedule = clearTimeout,
}: KeepAliveDeps = {} as KeepAliveDeps): KeepAlive {
  if (typeof ping !== "function") throw new Error("保活需要 ping 函数");
  const deadlines = new Map<number, number>();
  let nextId = 0;
  let timer: unknown = null;

  const live = (): boolean => {
    const current = now();
    for (const deadline of deadlines.values()) {
      if (deadline > current) return true;
    }
    return false;
  };

  function stop(): void {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  }

  function arm(): void {
    if (timer !== null) return;
    timer = schedule(tick, intervalMs);
    // Node 测试里别让计时器拖住进程；浏览器的计时器返回数字，没有 unref。
    (timer as { unref?: () => void } | null | undefined)?.unref?.();
  }

  function tick(): void {
    timer = null;
    if (!live()) return;
    // 调用本身就是保活，结果不重要；调用失败也只是少续这一次。
    try {
      Promise.resolve(ping()).catch(() => {});
    } catch (_) {
      // 同上：同步抛错也不能打断任务。
    }
    arm();
  }

  function hold(budgetMs: number): () => void {
    const id = (nextId += 1);
    deadlines.set(id, now() + Math.max(0, Number(budgetMs) || 0));
    arm();
    return function release() {
      if (!deadlines.delete(id)) return;
      if (!deadlines.size) stop();
    };
  }

  async function during<Result>(budgetMs: number, work: () => Result | Promise<Result>): Promise<Result> {
    const release = hold(budgetMs);
    try {
      return await work();
    } finally {
      release();
    }
  }

  return { hold, during };
}
