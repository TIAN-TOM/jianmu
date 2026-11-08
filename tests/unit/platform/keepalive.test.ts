// 保活：任务在跑时隔一会儿调一次扩展接口，撑着 service worker 不被回收；登记都撤掉或都过了上限就停表。
// 真浏览器里的回收由生命周期冒烟测试看；这里核对节奏、上限和容错。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeepAlive, keepAliveBudget } from "../../../src/platform/keepalive.ts";
import { EFFORT_TIMEOUT_SECONDS } from "../../../src/shared/settings-schema.ts";
import { deferred } from "../../helpers/deferred.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";

const INTERVAL = 20 * 1000;

function harness(ping?: () => unknown) {
  const timers = manualTimers();
  let pings = 0;
  const keepAlive = createKeepAlive({
    ping:
      ping ??
      (() => {
        pings += 1;
      }),
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { keepAlive, timers, pings: () => pings };
}

test("保活：登记期间每 20 秒调一次 ping，撤掉就立刻停表", () => {
  const h = harness();
  const release = h.keepAlive.hold(10 * 60 * 1000);
  assert.equal(h.timers.due(INTERVAL), 1);
  h.timers.advance(INTERVAL);
  h.timers.advance(INTERVAL);
  assert.equal(h.pings(), 2);
  release();
  assert.equal(h.timers.due(INTERVAL), 0, "没有登记了，不再排下一次");
  release();
  assert.equal(h.timers.due(INTERVAL), 0, "重复撤销不出错");
});

test("保活：同时有几份登记时，最后一份撤掉才停", () => {
  const h = harness();
  const task = h.keepAlive.hold(60 * 1000);
  const request = h.keepAlive.hold(60 * 1000);
  assert.equal(h.timers.due(INTERVAL), 1, "共用一个计时器");
  task();
  h.timers.advance(INTERVAL);
  assert.equal(h.pings(), 1, "还有一份在，照常保活");
  request();
  assert.equal(h.timers.due(INTERVAL), 0);
});

test("保活：过了截止时间不再续，即使任务一直没撤；新的登记重新起表", () => {
  const h = harness();
  h.keepAlive.hold(50 * 1000);
  h.timers.advance(INTERVAL);
  h.timers.advance(INTERVAL);
  assert.equal(h.pings(), 2);
  h.timers.advance(INTERVAL);
  assert.equal(h.pings(), 2, "60 秒时已经过了 50 秒的上限");
  assert.equal(h.timers.due(INTERVAL), 0, "表也停了，worker 可以休眠");

  const release = h.keepAlive.hold(50 * 1000);
  h.timers.advance(INTERVAL);
  assert.equal(h.pings(), 3);
  release();
});

test("保活：ping 同步抛错或异步被拒都不影响下一次", async () => {
  let calls = 0;
  const h = harness(() => {
    calls += 1;
    if (calls === 1) throw new Error("同步抛错");
    return Promise.reject(new Error("异步被拒"));
  });
  const work = deferred();
  const done = h.keepAlive.during(10 * 60 * 1000, () => work.promise);
  h.timers.advance(INTERVAL);
  h.timers.advance(INTERVAL);
  h.timers.advance(INTERVAL);
  assert.equal(calls, 3);
  work.resolve();
  await done;
  assert.equal(h.timers.due(INTERVAL), 0, "during 结束就撤掉");
});

test("保活上限按硬超时算：关和低档 11 分钟，中档 16 分钟，高档 26 分钟", () => {
  const minutes = (effort: keyof typeof EFFORT_TIMEOUT_SECONDS) => keepAliveBudget(EFFORT_TIMEOUT_SECONDS[effort] * 1000) / 60_000;
  assert.deepEqual(
    { off: minutes("off"), low: minutes("low"), medium: minutes("medium"), high: minutes("high") },
    { off: 11, low: 11, medium: 16, high: 26 },
  );
});
