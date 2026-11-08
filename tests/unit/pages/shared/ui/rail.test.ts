// 时间轨的版面：章节和分块按时长比例摆，数据不够就只剩细线；重点按起始秒精确匹配，生成中不显示。
import assert from "node:assert/strict";
import { test } from "node:test";
import { percent, railLayout, type RailPiece } from "../../../../../src/pages/shared/ui/rail.ts";

const CHAPTERS = [
  { startSec: 0, title: "开场" },
  { startSec: 120, title: "第一部分" },
  { startSec: 300, title: "第二部分" },
  { startSec: 540, title: "收尾" },
];

const shape = (pieces: readonly RailPiece[]) => pieces.map(({ index, kind, start, size, key }) => ({ index, kind, start, size, key }));

test("章节按时长比例分段，最后一段到视频结尾，序号和章节列表对得上", () => {
  const { pieces, playhead } = railLayout({ durationSec: 600, chapters: CHAPTERS });
  assert.deepEqual(shape(pieces), [
    { index: 0, kind: "chapter", start: 0, size: 0.2, key: false },
    { index: 1, kind: "chapter", start: 0.2, size: 0.3, key: false },
    { index: 2, kind: "chapter", start: 0.5, size: 0.4, key: false },
    { index: 3, kind: "chapter", start: 0.9, size: 0.1, key: false },
  ]);
  assert.deepEqual(pieces.map((piece) => piece.title), ["开场", "第一部分", "第二部分", "收尾"]);
  assert.equal(playhead, null, "不知道播放位置时没有播放头");
});

test("不知道时长、时长为零或没有落在时长里的章节，都只剩细线，不编分段", () => {
  for (const durationSec of [null, undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(railLayout({ durationSec, chapters: CHAPTERS, positionSec: 10 }), { pieces: [], playhead: null }, String(durationSec));
  }
  assert.deepEqual(railLayout({ durationSec: 600, chapters: [{ startSec: 600, title: "片尾之后" }] }).pieces, []);
  assert.deepEqual(railLayout({ durationSec: 600 }).pieces, []);
});

test("乱序、重复、越界和不是数的起点：排好序，同一秒只画第一章，丢掉坏的，序号仍是原来的", () => {
  const chapters = [
    { startSec: 300, title: "第二部分" },
    { startSec: Number.NaN, title: "坏的" },
    { startSec: 0, title: "开场" },
    { startSec: 300, title: "同一秒的另一章" },
    { startSec: 900, title: "超出时长" },
    { startSec: -1, title: "负数" },
  ];
  const { pieces } = railLayout({ durationSec: 600, chapters });
  assert.deepEqual(shape(pieces), [
    { index: 2, kind: "chapter", start: 0, size: 0.5, key: false },
    { index: 0, kind: "chapter", start: 0.5, size: 0.5, key: false },
  ]);
});

test("重点只认起始秒精确对上的章节，对不上的不猜最近的一章；第 0 秒也算", () => {
  const { pieces } = railLayout({ durationSec: 600, chapters: CHAPTERS, keyStarts: [0, 300, 123, Number.NaN] });
  assert.deepEqual(
    pieces.map((piece) => piece.key),
    [true, false, true, false],
  );
  const none = railLayout({ durationSec: 600, chapters: CHAPTERS });
  assert.ok(none.pieces.every((piece) => !piece.key), "没有重点字段时一章都不标");
});

test("播放位置：段内从头填已播放的比例，播放头在对应位置，超出时长按结尾算", () => {
  const { pieces, playhead } = railLayout({ durationSec: 600, chapters: CHAPTERS, positionSec: 210 });
  assert.deepEqual(
    pieces.map((piece) => piece.played),
    [1, 0.5, 0, 0],
  );
  assert.equal(playhead, 0.35);
  assert.equal(railLayout({ durationSec: 600, chapters: CHAPTERS, positionSec: 9999 }).playhead, 1);
  assert.equal(railLayout({ durationSec: 600, chapters: CHAPTERS, positionSec: -3 }).playhead, null);
});

test("悬停或当前章节按章节序号标出来，盖过重点的颜色由样式处理，这里两个标记都在", () => {
  const { pieces } = railLayout({ durationSec: 600, chapters: CHAPTERS, keyStarts: [120], focusIndex: 1 });
  assert.deepEqual(
    pieces.map(({ key, focus }) => [key, focus]),
    [
      [false, false],
      [true, true],
      [false, false],
      [false, false],
    ],
  );
});

test("分块生成中画分块进度，不画章节，也不显示重点；只有写完的块填已播放", () => {
  const blocks = [
    { startSec: 0, endSec: 200, state: "done" as const },
    { startSec: 200, endSec: 400, state: "writing" as const },
    { startSec: 400, endSec: 500, state: "failed" as const },
    { startSec: 500, endSec: 700, state: "pending" as const },
  ];
  const { pieces } = railLayout({ durationSec: 600, chapters: CHAPTERS, keyStarts: [0], blocks, positionSec: 300 });
  assert.deepEqual(
    pieces.map(({ kind, start, size, key, played }) => ({ kind, start: Number(start.toFixed(4)), size: Number(size.toFixed(4)), key, played })),
    [
      { kind: "done", start: 0, size: 0.3333, key: false, played: 1 },
      { kind: "writing", start: 0.3333, size: 0.3333, key: false, played: 0 },
      { kind: "failed", start: 0.6667, size: 0.1667, key: false, played: 0 },
      { kind: "pending", start: 0.8333, size: 0.1667, key: false, played: 0 },
    ],
  );
  assert.ok(pieces.every((piece) => piece.title === ""), "分块没有悬停提示");
});

test("比例写成样式里的百分数，限在 0 到 100，保留三位小数", () => {
  assert.equal(percent(0.35), "35%");
  assert.equal(percent(1 / 3), "33.333%");
  assert.equal(percent(-1), "0%");
  assert.equal(percent(2), "100%");
});
