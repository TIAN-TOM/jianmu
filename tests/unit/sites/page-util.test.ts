// 两站页面模块共用的小工具：等待能中止、定时能停、属性监听在没有 MutationObserver 时不出错、视频键和视频引用对得上。
import assert from "node:assert/strict";
import { test } from "node:test";
import { videoKey } from "../../../src/core/video-ref.ts";
import { keyOf, repeat, waitFor, watchAttribute } from "../../../src/sites/page-util.ts";

test("waitFor 到点就回，中止时按中止的原因拒绝，已经中止的不再等", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const done = new AbortController();
  let resolved = false;
  const waiting = waitFor(100, done.signal).then(() => {
    resolved = true;
  });
  t.mock.timers.tick(99);
  await Promise.resolve();
  assert.equal(resolved, false);
  t.mock.timers.tick(1);
  await waiting;
  assert.equal(resolved, true);

  const stopped = new AbortController();
  const pending = waitFor(100, stopped.signal);
  const reason = new Error("停下");
  stopped.abort(reason);
  await assert.rejects(pending, (error) => error === reason);

  await assert.rejects(waitFor(100, stopped.signal), (error) => error === reason);
});

test("repeat 每隔一段时间调一次，停了以后不再调", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  const stop = repeat(50, () => {
    runs += 1;
  });
  t.mock.timers.tick(150);
  assert.equal(runs, 3);
  stop();
  t.mock.timers.tick(150);
  assert.equal(runs, 3);
});

test("watchAttribute 只听给定的属性，停了就断开；没有 MutationObserver 时什么也不做", (t) => {
  const element = {} as Element;
  assert.equal(typeof MutationObserver, "undefined");
  const stopNothing = watchAttribute(element, "class", () => assert.fail("不该调"));
  stopNothing();

  const seen: { target: unknown; options: unknown }[] = [];
  let disconnected = false;
  class FakeObserver {
    observe(target: unknown, options: unknown): void {
      seen.push({ target, options });
    }
    disconnect(): void {
      disconnected = true;
    }
  }
  t.after(() => {
    delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  });
  (globalThis as { MutationObserver?: unknown }).MutationObserver = FakeObserver;
  const stop = watchAttribute(element, "class", () => undefined);
  assert.deepEqual(seen, [{ target: element, options: { attributes: true, attributeFilter: ["class"] } }]);
  stop();
  assert.equal(disconnected, true);
});

test("keyOf 没有视频时是 null，有视频时和 videoKey 一致", () => {
  assert.equal(keyOf(null), null);
  const ref = { platform: "youtube", videoId: "sample00001" } as const;
  assert.equal(keyOf(ref), videoKey(ref));
});
