// 悬停图标的露出规则：页面给了控制栏信号就跟着它；没给时鼠标在播放器上动过露几秒，移出去马上收；
// 鼠标停在图标上、挂着提示时一直露着。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReveal, REVEAL_MS } from "../../../src/content/reveal.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";

function setup() {
  const clock = manualTimers();
  const changes: boolean[] = [];
  const reveal = createReveal({
    onChange: (shown) => void changes.push(shown),
    timers: { now: clock.now, set: (run, ms) => clock.setTimeout(run, ms), clear: (timer) => clock.clearTimeout(timer) },
  });
  return { clock, changes, reveal };
}

test("一开始藏着，什么都没发生时不回调", () => {
  const { changes, reveal } = setup();
  assert.equal(reveal.shown(), false);
  assert.deepEqual(changes, []);
});

test("页面没给信号：鼠标动过露几秒，到点收起", () => {
  const { clock, changes, reveal } = setup();
  reveal.pointerMoved();
  assert.deepEqual(changes, [true]);
  clock.advance(REVEAL_MS - 1);
  assert.equal(reveal.shown(), true);
  clock.advance(1);
  assert.deepEqual(changes, [true, false]);
  assert.equal(clock.pending(), 0);
});

test("鼠标一直在动：从最后一次动算起，中间不重排计时器", () => {
  const { clock, changes, reveal } = setup();
  reveal.pointerMoved();
  for (let step = 0; step < 5; step += 1) {
    clock.advance(1000);
    reveal.pointerMoved();
    assert.equal(clock.pending(), 1);
  }
  clock.advance(REVEAL_MS - 1);
  assert.deepEqual(changes, [true]);
  clock.advance(1);
  assert.deepEqual(changes, [true, false]);
});

test("鼠标移出播放器马上收起，计时器撤掉", () => {
  const { clock, changes, reveal } = setup();
  reveal.pointerMoved();
  reveal.pointerLeft();
  assert.deepEqual(changes, [true, false]);
  assert.equal(clock.pending(), 0);
});

test("页面给了信号就跟着它，鼠标动不动都不算", () => {
  const { clock, changes, reveal } = setup();
  reveal.controls(false);
  reveal.pointerMoved();
  assert.deepEqual(changes, []);
  reveal.controls(true);
  assert.deepEqual(changes, [true]);
  clock.advance(REVEAL_MS * 2);
  assert.equal(reveal.shown(), true);
  reveal.controls(false);
  assert.deepEqual(changes, [true, false]);
});

test("信号没了退回看鼠标", () => {
  const { clock, changes, reveal } = setup();
  reveal.controls(true);
  reveal.controls(null);
  assert.deepEqual(changes, [true, false]);
  reveal.pointerMoved();
  assert.equal(reveal.shown(), true);
  clock.advance(REVEAL_MS);
  assert.equal(reveal.shown(), false);
});

test("鼠标停在图标上时不收：到点、控制栏藏了都一样", () => {
  const { clock, reveal } = setup();
  reveal.pointerMoved();
  reveal.hover(true);
  clock.advance(REVEAL_MS);
  assert.equal(reveal.shown(), true);
  reveal.controls(false);
  assert.equal(reveal.shown(), true);
  reveal.hover(false);
  assert.equal(reveal.shown(), false);
});

test("鼠标移出播放器时，停在图标上的状态一起清掉", () => {
  const { reveal } = setup();
  reveal.pointerMoved();
  reveal.hover(true);
  reveal.pointerLeft();
  assert.equal(reveal.shown(), false);
});

test("挂着提示时一直露着，提示撤了回到原来的规则", () => {
  const { changes, reveal } = setup();
  reveal.controls(false);
  reveal.hold(true);
  assert.deepEqual(changes, [true]);
  reveal.hold(false);
  assert.deepEqual(changes, [true, false]);
});

test("停下以后计时器不再触发", () => {
  const { clock, changes, reveal } = setup();
  reveal.pointerMoved();
  reveal.stop();
  assert.equal(clock.pending(), 0);
  clock.advance(REVEAL_MS);
  assert.deepEqual(changes, [true]);
});
