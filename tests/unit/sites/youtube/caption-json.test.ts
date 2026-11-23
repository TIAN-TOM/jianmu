// 播放器取回的带时间轴字幕的解析：一事件一句、片段拼起来，空的和只有换行的丢掉；时间倒走、条数和字数超限整份不用；读不懂是 null。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCaptionJson, type CaptionJsonLimits } from "../../../../src/sites/youtube/caption-json.ts";
import { PANEL_LIMITS } from "../../../../src/sites/youtube/page/panel-types.ts";

const parse = (value: unknown, limits: CaptionJsonLimits = PANEL_LIMITS) => parseCaptionJson(typeof value === "string" ? value : JSON.stringify(value), limits);

test("人工字幕和按词分片段的自动字幕都拼成一句一句；只管位置的、空的、只有换行的事件丢掉", () => {
  const events = [
    { tStartMs: 0, dDurationMs: 600000, id: 1, wpWinPosId: 1 },
    { tStartMs: 1200, dDurationMs: 3000, wWinId: 1, segs: [{ utf8: "sample" }, { utf8: " words", tOffsetMs: 400 }, { utf8: " here", tOffsetMs: 800 }] },
    { tStartMs: 2900, dDurationMs: 100, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 3000, segs: [{ utf8: "  " }] },
    { tStartMs: 3000, segs: [{ utf8: "second\nline" }] },
    { tStartMs: 7000, segs: [] },
  ];
  assert.deepEqual(parse({ wireMagic: "sample", events }), [
    { start: 1.2, text: "sample words here" },
    { start: 3, text: "second line" },
  ]);
  assert.deepEqual(parse({ events: [] }), []);
});

test("读不懂、时间倒着走、超出上限：整份不用，返回 null，不抛", () => {
  for (const bad of ["不是 JSON", "", "[]", { events: "x" }, { events: [1] }, { events: [{ tStartMs: 0, segs: "x" }] }, { events: [{ tStartMs: 0, segs: [{ text: "x" }] }] }]) {
    assert.equal(parse(bad), null, JSON.stringify(bad));
  }
  assert.equal(parse({ events: [{ segs: [{ utf8: "no time" }] }] }), null);
  assert.equal(parse({ events: [{ tStartMs: -1, segs: [{ utf8: "x" }] }] }), null);
  assert.equal(parse({ events: [{ tStartMs: 5000, segs: [{ utf8: "b" }] }, { tStartMs: 1000, segs: [{ utf8: "a" }] }] }), null);
  const many = { events: Array.from({ length: 3 }, (_, index) => ({ tStartMs: index * 1000, segs: [{ utf8: `line ${index}` }] })) };
  assert.equal(parse(many, { ...PANEL_LIMITS, cues: 2 }), null);
  assert.equal(parse(many, { ...PANEL_LIMITS, totalText: 10 }), null);
  assert.equal(parse({ events: [{ tStartMs: (PANEL_LIMITS.seconds + 1) * 1000, segs: [{ utf8: "x" }] }] }), null);
});

test("每句照上限截断", () => {
  const long = "x".repeat(PANEL_LIMITS.cueText + 10);
  assert.equal(parse({ events: [{ tStartMs: 0, segs: [{ utf8: long }] }] })?.[0]?.text.length, PANEL_LIMITS.cueText);
});
