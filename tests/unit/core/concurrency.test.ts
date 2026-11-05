import assert from "node:assert/strict";
import { test } from "node:test";
import { createLimiter, createSerialQueue, mapWithConcurrency } from "../../../src/core/concurrency.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 结果是 allSettled 形状，这两个函数取出其中一边，另一边读出来是 undefined，断言对不上。
const valueOf = <T>(result: PromiseSettledResult<T> | undefined): T | undefined =>
  result?.status === "fulfilled" ? result.value : undefined;

const reasonOf = (result: PromiseSettledResult<unknown> | undefined): Error | undefined =>
  result?.status === "rejected" ? result.reason : undefined;

// 并发池

test("结果按输入顺序返回，与完成顺序无关", async () => {
  // 故意让先入队的慢、后入队的快，制造完成顺序与输入顺序相反的情况
  const results = await mapWithConcurrency([30, 20, 10, 0], 4, async (ms, i) => {
    await delay(ms);
    return i;
  });
  assert.deepEqual(
    results.map((result) => valueOf(result)),
    [0, 1, 2, 3],
  );
});

test("并发数不会超过上限", async () => {
  let active = 0;
  let peak = 0;

  await mapWithConcurrency(Array.from({ length: 20 }), 3, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(5);
    active -= 1;
  });

  assert.equal(peak, 3, `实际峰值并发 ${peak}，超过了上限`);
});

test("每一项都只被处理一次", async () => {
  const seen: number[] = [];
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 4, async (item) => {
    await delay(1);
    seen.push(item);
  });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("单个失败不影响其余任务，返回 settled 形状", async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    if (item === 2) throw new Error("第二个失败了");
    return item * 10;
  });

  assert.equal(results[0]?.status, "fulfilled");
  assert.equal(valueOf(results[0]), 10);
  assert.equal(results[1]?.status, "rejected");
  assert.equal(reasonOf(results[1])?.message, "第二个失败了");
  assert.equal(valueOf(results[3]), 40);
});

test("进度回调按完成数递增，最终等于总数", async () => {
  const progress: [number, number][] = [];
  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => delay(1), (done, total) => {
    progress.push([done, total]);
  });

  assert.equal(progress.length, 5);
  assert.deepEqual(
    progress.map(([done]) => done),
    [1, 2, 3, 4, 5],
  );
  assert.ok(progress.every(([, total]) => total === 5));
});

test("进度回调自己抛错不会影响任务", async () => {
  const results = await mapWithConcurrency([1, 2], 1, async (item) => item, () => {
    throw new Error("回调炸了");
  });
  assert.equal(valueOf(results[0]), 1);
  assert.equal(valueOf(results[1]), 2);
});

test("空输入直接返回空数组，不调用 worker", async () => {
  let called = false;
  const results = await mapWithConcurrency([], 4, async () => {
    called = true;
  });
  assert.deepEqual(results, []);
  assert.equal(called, false);
});

test("并发数非法时回落到 1，且不会超过任务数", async () => {
  for (const limit of [0, -5, NaN, undefined, "abc"]) {
    const results = await mapWithConcurrency([1, 2], limit, async (item) => item);
    assert.deepEqual(
      results.map((result) => valueOf(result)),
      [1, 2],
      `limit=${limit} 时结果不对`,
    );
  }

  let peak = 0;
  let active = 0;
  await mapWithConcurrency([1, 2], 100, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(1);
    active -= 1;
  });
  assert.equal(peak, 2, "并发数不该超过任务数");
});

// 串行队列

test("排队的任务严格逐个执行，不会重叠", async () => {
  const enqueue = createSerialQueue();
  const order: string[] = [];
  let active = 0;
  let overlapped = false;

  const task = (id: string, ms: number) => async () => {
    active += 1;
    if (active > 1) overlapped = true;
    await delay(ms);
    order.push(id);
    active -= 1;
    return id;
  };

  // 先入队的故意最慢，若队列失效，快的会先跑完
  await Promise.all([
    enqueue(task("a", 20)),
    enqueue(task("b", 10)),
    enqueue(task("c", 0)),
  ]);

  assert.equal(overlapped, false, "出现了重叠执行，临界区没有被保护住");
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("读—改—写并发时不会丢更新", async () => {
  const enqueue = createSerialQueue();
  let store: Record<string, boolean> = {};

  // 模拟缓存的读—改—写：读出快照、改一个键、整份写回
  const update = (key: string) =>
    enqueue(async () => {
      const snapshot = store;
      await delay(5); // 读和写之间的空窗，正是覆盖发生的地方
      store = { ...snapshot, [key]: true };
    });

  await Promise.all([update("a"), update("b"), update("c")]);
  assert.deepEqual(Object.keys(store).sort(), ["a", "b", "c"]);
});

test("队列中某个任务失败后，后续任务照常执行", async () => {
  const enqueue = createSerialQueue();
  const done: string[] = [];

  const failing = enqueue(async () => {
    throw new Error("中间这个失败了");
  });
  await assert.rejects(failing, /中间这个失败了/);

  await enqueue(async () => {
    done.push("之后的任务");
  });
  assert.deepEqual(done, ["之后的任务"]);
});

test("调用方能拿到各自任务的返回值与错误", async () => {
  const enqueue = createSerialQueue();
  assert.equal(await enqueue(async () => "结果"), "结果");
  await assert.rejects(enqueue(async () => {
    throw new Error("我的错误");
  }), /我的错误/);
});

// 跨任务共享的并发闸门

test("几个任务共用一道闸门时，同时在跑的总数不超过上限", async () => {
  const run = createLimiter();
  let active = 0;
  let peak = 0;
  const job = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(5);
    active -= 1;
  };
  // 两个视频各 4 块，各自的池子开 3 个并发，总数仍要压在 3 以内。
  const video = () => mapWithConcurrency([1, 2, 3, 4], 3, () => run(3, job));
  await Promise.all([video(), video()]);
  assert.equal(peak, 3);
});

test("名额交接时新来的调用不能插队把并发顶破", async () => {
  const run = createLimiter();
  let active = 0;
  let peak = 0;
  const holders = [deferred(), deferred(), deferred()] as const;
  const job = (holder: Deferred) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await holder.promise;
    active -= 1;
  };
  // 有空位时 run() 同步调用任务，限流器内部的 await 先挂在任务的 promise 上。
  let firstTask!: Promise<void>;
  const first = run(1, () => {
    firstTask = job(holders[0])();
    return firstTask;
  });
  const second = run(1, job(holders[1]));
  // 在任务的 promise 上、排在限流器后面挂回调：任务一结束，限流器先放行第二个，
  // 紧接着这里塞进第三个，这时第二个还没恢复执行。名额要在放行时就记给第二个，第三个才插不进来。
  let third!: Promise<void>;
  const thirdQueued = firstTask.then(() => {
    third = run(1, job(holders[2]));
  });
  holders[0].resolve();
  await thirdQueued;
  holders[1].resolve();
  holders[2].resolve();
  await Promise.all([first, second, third]);
  assert.equal(peak, 1);
});

test("任务出错也会归还名额，排队的照常执行", async () => {
  const run = createLimiter();
  const failing = run(1, async () => {
    throw new Error("限流");
  });
  const next = run(1, async () => "ok");
  await assert.rejects(failing, /限流/);
  assert.equal(await next, "ok");
  assert.equal(await run(1, async () => "still ok"), "still ok");
});

// 可控的「挂起中」任务：由测试决定什么时候让它结束。
type Deferred = ReturnType<typeof deferred>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 取消是同步判定的，排空这一轮微任务后还没结束就算挂起，不靠计时器。
const settledState = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => "resolved",
      (error: { code?: string } | undefined) => error?.code || "rejected",
    ),
    new Promise<string>((resolve) => setImmediate(resolve, "pending")),
  ]);

const isCanceled = (error: unknown) => (error as { code?: string }).code === "TASK_CANCELED";

test("排队中的请求被取消时立刻出队，不等别人让出名额", async () => {
  const run = createLimiter();
  const holder = deferred();
  const first = run(1, () => holder.promise);
  const controller = new AbortController();
  let ran = false;
  const queued = run(
    1,
    async () => {
      ran = true;
    },
    { signal: controller.signal },
  );
  const after = run(1, async () => "接班");

  controller.abort();
  assert.equal(
    await settledState(queued),
    "TASK_CANCELED",
    "取消后应立即以 TASK_CANCELED 结束，而不是继续占着队位等名额",
  );

  holder.resolve();
  await first;
  assert.equal(await after, "接班", "取消的那个出队后，名额照常交给后面排队的");
  assert.equal(ran, false, "被取消的请求不会再执行");
});

test("已经取消的信号直接拒绝，不进队也不占名额", async () => {
  const run = createLimiter();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(1, async () => "不该执行", { signal: controller.signal }), isCanceled);
  assert.equal(await run(1, async () => "ok"), "ok");
});

test("调低上限后开的任务，实际并发会降到新上限", async () => {
  const run = createLimiter();
  const holders = [deferred(), deferred(), deferred()];
  // 旧任务按上限 3 跑满。
  const old = holders.map((holder) => run(3, () => holder.promise));

  let active = 0;
  let peak = 0;
  const job = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await delay(3);
    active -= 1;
  };
  // 设置改成 1 之后开的新任务，排在后面。
  const fresh = [run(1, job), run(1, job), run(1, job)];

  for (const holder of holders) holder.resolve();
  await Promise.all([...old, ...fresh]);
  assert.equal(peak, 1, "名额释放时要按新上限重新判断，不能原样交接给排队的");
});

test("队首被取消后，后面能放行的立刻补上", async () => {
  const run = createLimiter();
  const holders = [deferred(), deferred()];
  const running = holders.map((holder) => run(2, () => holder.promise));
  // 队首要求上限 1，在跑 2 个时放不进去；它后面的要求上限 3。
  const controller = new AbortController();
  const strict = run(1, async () => "strict", { signal: controller.signal });
  let started = false;
  const loose = run(3, async () => {
    started = true;
    return "loose";
  });

  // 放不放行在排队时就决定了，不经过计时器：排空一轮微任务后还没开跑，就是被挡在队首后面。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false, "先来后到：队首放不进去时，后面的不越过它");
  controller.abort();
  await assert.rejects(strict, isCanceled);
  assert.equal(await loose, "loose");

  for (const holder of holders) holder.resolve();
  await Promise.all(running);
});
