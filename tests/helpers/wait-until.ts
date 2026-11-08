// 按条件等异步结果：每轮让已经就绪的回调都跑完再看一次，不按固定的毫秒数等，机器忙时也不会偶发失败。
// 条件一直不成立时等到上限就回 false，由调用方断言。

export async function until(check: () => boolean | Promise<boolean>, rounds = 1000): Promise<boolean> {
  for (let round = 0; round < rounds; round += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}
