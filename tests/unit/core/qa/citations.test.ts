import assert from "node:assert/strict";
import { test } from "node:test";
import { groundQaAnswer, splitAnswerByTimestamps } from "../../../../src/core/qa/citations.ts";

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

test("splitAnswerByTimestamps：四位分钟照认，秒不是两位或超过 59 的不算时间点，区间取起点", () => {
  assert.deepEqual(splitAnswerByTimestamps("见 [1000:30] 处"), [
    { text: "见 " },
    { text: "1000:30", seconds: 60030 },
    { text: " 处" },
  ]);
  assert.deepEqual(splitAnswerByTimestamps("见 [3:5] 处"), [{ text: "见 [3:5] 处" }]);
  assert.deepEqual(splitAnswerByTimestamps("见 [1:75] 处"), [{ text: "见 [1:75] 处" }]);
  assert.deepEqual(splitAnswerByTimestamps("见 [2:00-1000:30] 处"), [
    { text: "见 " },
    { text: "2:00-1000:30", seconds: 120 },
    { text: " 处" },
  ]);
});

test("短引在不同位置重复时只认确实相符的起点；没写原文或引错的要点不能借另一条出处过关", () => {
  const rows = [{ start: 12, text: "船已经靠岸。" }, { start: 97, text: "船已经靠岸。请带好行李。" }];
  const result = groundQaAnswer([
    "靠岸了。【0:30|船已经靠岸】",
    "请带行李。【0:12|请带好行李】",
    "第二次靠岸。【1:37|船已经靠岸】",
    "又问了一遍。[0:12]",
    "有一条是真的。【0:12|船已经靠岸】【1:37|船已经离岸】",
  ].join("\n"), rows);
  assert.equal(result.answer, "请带行李。[1:37]\n第二次靠岸。[1:37]");
  assert.deepEqual(result.citations, [{ startSeconds: 97, quote: "船已经靠岸。请带好行李。" }]);
});
