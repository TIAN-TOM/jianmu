import assert from "node:assert/strict";
import { test } from "node:test";
import { subtitleTimelineMismatch } from "../../../../src/core/transcript/mismatch.ts";

// 从 0 秒到 lastEnd 秒均匀铺 count 条字幕。
const lines = (lastEnd: number, count = 5): { text: string; start: number; duration: number }[] =>
  Array.from({ length: count }, (_, i) => {
    const end = (lastEnd * (i + 1)) / count;
    const start = Math.max(0, end - 2);
    return { text: `第 ${i + 1} 句`, start, duration: end - start };
  });

test("时长拿不到（0、缺失、非数字）或字幕没有时间轴时不判断", () => {
  const far = lines(5000);
  for (const duration of [0, undefined, null, NaN, -10, "abc"]) {
    assert.equal(subtitleTimelineMismatch(far, duration), "", `duration=${duration}`);
  }
  assert.equal(subtitleTimelineMismatch([], 600), "");
  assert.equal(subtitleTimelineMismatch(null, 600), "");
  // 时间戳全是 0：没法说它覆盖了多少，不当成只覆盖开头。
  assert.equal(subtitleTimelineMismatch([{ text: "a", start: 0, duration: 0 }], 1800), "");
});

test("最后一句结束得比视频晚，超过 max(30 秒, 时长 10%) 才算对不上", () => {
  // 2 分钟的视频：容差 30 秒。
  assert.equal(subtitleTimelineMismatch(lines(125), 120), "", "片尾多出几秒是常态");
  assert.equal(subtitleTimelineMismatch(lines(149), 120), "");
  assert.equal(subtitleTimelineMismatch(lines(151), 120), "overrun");
  // 1 小时的视频：容差 6 分钟。
  assert.equal(subtitleTimelineMismatch(lines(3900), 3600), "");
  assert.equal(subtitleTimelineMismatch(lines(3961), 3600), "overrun");
});

test("10 分钟以上的视频，字幕只覆盖开头不到三成才算对不上", () => {
  assert.equal(subtitleTimelineMismatch(lines(260), 900), "undercoverage");
  assert.equal(subtitleTimelineMismatch(lines(280), 900), "", "超过三成就不判");
  // 片尾两分钟音乐、没人说话：照常。
  assert.equal(subtitleTimelineMismatch(lines(480), 600), "");
  // 不到 10 分钟的视频不看覆盖比例：短视频后半段纯画面很常见。
  assert.equal(subtitleTimelineMismatch(lines(30), 540), "");
});

test("开头静音不影响判断；按最晚的结束时间算，不依赖字幕的排列顺序", () => {
  const lateStart = [
    { text: "开口", start: 120, duration: 3 },
    { text: "收尾", start: 585, duration: 5 },
  ];
  assert.equal(subtitleTimelineMismatch(lateStart, 600), "");
  const unsorted = [
    { text: "末句", start: 3958, duration: 5 },
    { text: "首句", start: 1, duration: 2 },
  ];
  assert.equal(subtitleTimelineMismatch(unsorted, 3600), "overrun");
});
