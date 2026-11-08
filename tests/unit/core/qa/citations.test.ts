import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCitationsFromAnswer,
  clickableTimestamps,
  extractTimestamps,
  secondsToTimestamp,
  splitAnswerByTimestamps,
  timestampToSeconds,
} from "../../../../src/core/qa/citations.ts";

test("时间戳解析：M:SS 双向转换，非法输入拒绝", () => {
  assert.equal(timestampToSeconds("03:12"), 192);
  assert.equal(timestampToSeconds("0:05"), 5);
  assert.equal(timestampToSeconds("75:20"), 4520, "超一小时延续分钟制");
  assert.equal(timestampToSeconds("1000:30"), 60030, "四位分钟：超长直播回放不丢引用");
  assert.equal(timestampToSeconds("3:5"), null, "秒必须两位");
  assert.equal(timestampToSeconds(""), null);
  assert.equal(secondsToTimestamp(192), "3:12");
});

test("extractTimestamps 抽出全部合法 token", () => {
  const found = extractTimestamps("开头 [0:32] 中间 [12:00] 结尾 [bad]");
  assert.deepEqual(found, [
    { raw: "[0:32]", seconds: 32 },
    { raw: "[12:00]", seconds: 720 },
  ]);
});

test("buildCitationsFromAnswer：从字幕本地提取依据，越界与重复剔除", () => {
  const entries = [
    { start: 0, text: "第一句话讲概念" },
    { start: 60, text: "第二句给出结论" },
    { start: 200, text: "收尾" },
  ];
  const range = { min: 0, max: 300 };

  const citations = buildCitationsFromAnswer(
    "开头 [0:10] 结论 [1:05] 越界 [9:99] 重复 [0:10]",
    entries,
    range,
  );

  assert.deepEqual(citations, [
    { startSeconds: 10, quote: "第一句话讲概念" },
    { startSeconds: 65, quote: "第二句给出结论" },
  ]);
});

test("buildCitationsFromAnswer：时间戳落在两句之间时归前一句", () => {
  const entries = [
    { start: 0, text: "第一句" },
    { start: 60, text: "第二句" },
  ];
  const citations = buildCitationsFromAnswer(
    "引用 [0:59]",
    entries,
    { min: 0, max: 120 },
  );
  assert.deepEqual(citations, [{ startSeconds: 59, quote: "第一句" }]);
});

test("buildCitationsFromAnswer：空字幕或无时间戳返回空数组", () => {
  assert.deepEqual(
    buildCitationsFromAnswer("没有引用", [], { min: 0, max: 10 }),
    [],
  );
  assert.deepEqual(
    buildCitationsFromAnswer("[0:05] 有引用", [], { min: 0, max: 10 }),
    [],
  );
});

test("clickableTimestamps 返回落在区间内的秒数集合", () => {
  const clickable = clickableTimestamps(
    "见 [0:10] 与 [2:30]，后者越界",
    { min: 0, max: 130 },
  );
  assert.ok(clickable.has(10));
  assert.ok(!clickable.has(150), "2:30 = 150s 超出 max 130");
});

test("extractTimestamps 支持区间格式，取起点", () => {
  const found = extractTimestamps("依据见 [0:11-0:23] 与单点 [2:00]");
  assert.deepEqual(found, [
    { raw: "[0:11-0:23]", seconds: 11 },
    { raw: "[2:00]", seconds: 120 },
  ]);
});

test("splitAnswerByTimestamps：单点、区间、混合与无时间戳", () => {
  assert.deepEqual(splitAnswerByTimestamps("结论 [0:11-0:23] 收尾"), [
    { text: "结论 " },
    { text: "0:11-0:23", seconds: 11 },
    { text: " 收尾" },
  ]);
  assert.deepEqual(splitAnswerByTimestamps("没有时间戳"), [
    { text: "没有时间戳" },
  ]);
  const mixed = splitAnswerByTimestamps("[1:00]和[1:30-2:00]");
  assert.deepEqual(
    mixed.filter((segment) => segment.seconds != null).map((s) => s.seconds),
    [60, 90],
  );
});

test("引用区间的端点按整秒放宽：起点向下取整，终点向上取整", () => {
  // 送进模型的块起止可能带小数，回答里的时间戳只到整秒。
  const single = clickableTimestamps("[0:09] [0:10] [0:21] [0:22]", { min: 10.7, max: 20.2 });
  assert.deepEqual([...single], [10, 21]);

  const split = clickableTimestamps("[0:10] [0:21] [0:22] [0:29] [0:30] [0:41]", {
    min: 10.7,
    max: 40.1,
    ranges: [
      { min: 10.7, max: 20.2 },
      { min: 30.5, max: 40.1 },
    ],
  });
  assert.deepEqual([...split], [10, 21, 30, 41], "分段时每一段的端点各自取整");

  const entries = [{ start: 0, text: "开场" }];
  assert.deepEqual(
    buildCitationsFromAnswer("[0:10] [0:22]", entries, { min: 10.7, max: 20.2 }).map((item) => item.startSeconds),
    [10],
    "依据条目用同一条取整规则",
  );
});

test("下一句没有有效起点时，前一句一直管到再下一句，依据不落到起点丢失的那句", () => {
  // 起点为 0 或缺失的条目夹在中间，多半是字幕数据坏了；当它不存在。
  for (const broken of [{ start: 0, text: "起点丢了" }, { text: "起点丢了" }]) {
    const entries = [{ start: 10, text: "第一句" }, { start: 30, text: "第二句" }, broken as { start: number; text: string }];
    assert.deepEqual(
      buildCitationsFromAnswer("[0:45]", entries, { min: 0, max: 120 }),
      [{ startSeconds: 45, quote: "第二句" }],
      JSON.stringify(broken),
    );
  }
});

test("字幕起点带小数时按整秒对齐，第一句没有起点时按 0 算，依据去掉首尾空白", () => {
  const entries = [
    { start: 0, text: "第一句" },
    { start: 30.6, text: " 第二句 " },
    { start: 60, text: "第三句" },
  ];
  assert.deepEqual(
    buildCitationsFromAnswer("[0:29] [0:30]", entries, { min: 0, max: 120 }),
    [
      { startSeconds: 29, quote: "第一句" },
      { startSeconds: 30, quote: "第二句" },
    ],
  );

  const missingFirst = [{ text: "开场" }, { start: 30, text: "第二句" }] as { start: number; text: string }[];
  assert.deepEqual(buildCitationsFromAnswer("[0:00]", missingFirst, { min: 0, max: 120 }), [
    { startSeconds: 0, quote: "开场" },
  ]);
});

test("时间戳两边的空白不影响解析，秒数转回时间戳时向下取整", () => {
  assert.equal(timestampToSeconds(" 3:12 "), 192);
  assert.equal(secondsToTimestamp(192.7), "3:12");
  assert.equal(secondsToTimestamp(59.99), "0:59");
});
