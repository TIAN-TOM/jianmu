// 按条件等异步结果：每轮让已经就绪的回调都跑完再看一次，成立就马上回，不按固定的毫秒数等。
// 有的异步不在事件循环里转（算哈希交给线程池这类），机器忙时它多久回来和转了几轮无关：
// 所以条件一直不成立时，要转满 rounds 轮、而且至少过了 MIN_WAIT_MS 才认输回 false，由调用方断言。
// 要确认某件事「没有发生」，用 stillFalse：它只按轮数等，等到眼下就绪的都跑完。

/** 等「会发生」的事最少等多久才认输。只在条件一直不成立（测试本来就要失败）时才真的等满。 */
export const MIN_WAIT_MS = 5_000;

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function until(check: () => boolean | Promise<boolean>, rounds = 1000): Promise<boolean> {
  const started = performance.now();
  for (let round = 0; ; round += 1) {
    if (await check()) return true;
    if (round >= rounds && performance.now() - started >= MIN_WAIT_MS) return false;
    // 转满轮数还没等到：剩下的多半是线程池那类异步，隔一小会儿再看，不空转抢 CPU。
    if (round >= rounds) await new Promise((resolve) => setTimeout(resolve, 5));
    else await nextTurn();
  }
}

/** 转 rounds 轮，条件一直不成立就回 true：用来确认某件事没有发生，比如排在闸门外的请求没有自己发出去。 */
export async function stillFalse(check: () => boolean | Promise<boolean>, rounds = 1000): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (await check()) return false;
    await nextTurn();
  }
  return !(await check());
}
