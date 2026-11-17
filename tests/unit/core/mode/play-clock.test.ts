// 播放计时（PRD 6.3）：按实际播放累计，暂停不清零，拖动跳过的不算，广告不算，倍速按真实时间算，单次采样最多计 1.5 秒，刷新后接着计。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlayClock, MAX_STEP_SEC, type PlaySample } from "../../../../src/core/mode/play-clock.ts";

/** 每秒一次采样，从 at 毫秒、position 秒开始。 */
function play(clock: ReturnType<typeof createPlayClock>, from: { at: number; position: number }, seconds: number, patch: Partial<PlaySample> = {}) {
  let { at, position } = from;
  const rate = patch.rate ?? 1;
  for (let i = 0; i < seconds; i += 1) {
    at += 1000;
    position += rate;
    clock.sample({ at, position, rate, playing: true, ...patch });
  }
  return { at, position };
}

test("连续播放按真实经过的时间累计；暂停时不计，但不清零", () => {
  const clock = createPlayClock();
  clock.sample({ at: 0, position: 0, rate: 1, playing: true });
  let now = play(clock, { at: 0, position: 0 }, 30);
  assert.equal(clock.playedSec(), 30);
  // 暂停 20 秒：位置不动、不在播。
  for (let i = 0; i < 20; i += 1) clock.sample({ at: (now.at += 1000), position: now.position, rate: 1, playing: false });
  assert.equal(clock.playedSec(), 30);
  // 恢复播放：恢复那一刻的样本前一条不在播，不计；之后接着累计。
  clock.sample({ at: (now.at += 1000), position: now.position, rate: 1, playing: true });
  now = play(clock, now, 10);
  assert.equal(clock.playedSec(), 40);
});

test("倍速按真实时间算：两倍速播 30 秒真实时间算 30 秒，不算 60 秒", () => {
  const clock = createPlayClock();
  clock.sample({ at: 0, position: 0, rate: 2, playing: true });
  play(clock, { at: 0, position: 0 }, 30, { rate: 2 });
  assert.equal(clock.playedSec(), 30);
});

test("拖动：位置比按倍速推算的多走或少走超过 2 秒，这一段不计；之后正常播放接着计", () => {
  const clock = createPlayClock();
  clock.sample({ at: 0, position: 100, rate: 1, playing: true });
  clock.sample({ at: 1000, position: 400, rate: 1, playing: true });
  assert.equal(clock.playedSec(), 0, "往后跳");
  clock.sample({ at: 2000, position: 50, rate: 1, playing: true });
  assert.equal(clock.playedSec(), 0, "往回跳");
  play(clock, { at: 2000, position: 50 }, 5);
  assert.equal(clock.playedSec(), 5);
  clock.sample({ at: 8000, position: 55 + 1 + 1.9, rate: 1, playing: true });
  assert.equal(clock.playedSec(), 6, "差在 2 秒以内照样计");
});

test("广告、没画面、在拖动这些报不在播的采样都不计", () => {
  const clock = createPlayClock();
  clock.sample({ at: 0, position: 0, rate: 1, playing: false });
  for (let i = 1; i <= 15; i += 1) clock.sample({ at: i * 1000, position: 0, rate: 1, playing: false });
  assert.equal(clock.playedSec(), 0);
});

test("后台标签页被节流、两次采样隔得久：单次最多计 1.5 秒", () => {
  const clock = createPlayClock();
  clock.sample({ at: 0, position: 0, rate: 1, playing: true });
  clock.sample({ at: 1000, position: 1, rate: 1, playing: true });
  clock.sample({ at: 61_000, position: 61, rate: 1, playing: true });
  assert.equal(clock.playedSec(), 1 + MAX_STEP_SEC);
});

test("刷新同一个视频：从后台回的累计秒数接着计；时间倒退或不是数的起点按 0 算", () => {
  const clock = createPlayClock(47);
  clock.sample({ at: 0, position: 0, rate: 1, playing: true });
  play(clock, { at: 0, position: 0 }, 3);
  assert.equal(clock.playedSec(), 50);
  assert.equal(createPlayClock(Number.NaN).playedSec(), 0);
  const backwards = createPlayClock();
  backwards.sample({ at: 5000, position: 0, rate: 1, playing: true });
  backwards.sample({ at: 4000, position: 0, rate: 1, playing: true });
  assert.equal(backwards.playedSec(), 0);
});
