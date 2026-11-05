// 黄金样本重放：样本的 args 原样传给被测函数，输出编码后和 result 逐字节比。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildCitationsFromAnswer,
  clickableTimestamps,
  extractTimestamps,
  secondsToTimestamp,
  splitAnswerByTimestamps,
  timestampToSeconds,
  type CitationEntry,
  type CitationRange,
} from "../../../../src/core/qa/citations.ts";
import {
  questionTerms,
  scoreChunks,
  selectContext,
  type QaChapter,
  type QaChunk,
  type SelectContextInput,
} from "../../../../src/core/qa/retrieval.ts";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly result: unknown;
}

const REPLAY: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
  questionTerms: ([question]) => questionTerms(question as string),
  scoreChunks: ([chunks, question, chapters]) =>
    scoreChunks(chunks as QaChunk[], question as string, chapters as QaChapter[] | undefined),
  selectContext: ([input]) => selectContext(input as SelectContextInput),
  timestampToSeconds: ([token]) => timestampToSeconds(token as string | null),
  secondsToTimestamp: ([seconds]) => secondsToTimestamp(seconds as number),
  extractTimestamps: ([text]) => extractTimestamps(text as string),
  splitAnswerByTimestamps: ([answer]) => splitAnswerByTimestamps(answer as string),
  buildCitationsFromAnswer: ([answer, entries, range]) =>
    buildCitationsFromAnswer(answer as string, entries as CitationEntry[], range as CitationRange),
  clickableTimestamps: ([answer, range]) => clickableTimestamps(answer as string, range as CitationRange),
};

// 样本里只有 $number 一种入参标记，非有限数 JSON 写不出来。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$number" in value) return Number(value.$number);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

// 和样本的编码规则一致：Set、undefined、非有限数留痕，键按字典序。
function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null) return null;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (!Number.isFinite(value)) return { $number: value > 0 ? "Infinity" : "-Infinity" };
    return value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Set) return { $set: [...value].map(encode) };
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([key, item]) => [key, encode(item)]));
}

const { cases } = JSON.parse(
  readFileSync(new URL("../../../fixtures/golden/qa.json", import.meta.url), "utf8"),
) as { cases: GoldenCase[] };

test("样本覆盖全部用例和函数", () => {
  assert.equal(cases.length, 80);
  assert.deepEqual([...new Set(cases.map((item) => item.fn))].sort(), Object.keys(REPLAY).sort());
});

for (const item of cases) {
  test(`黄金样本 ${item.id} ${item.label}`.trim(), () => {
    const replay = REPLAY[item.fn];
    assert.ok(replay, `样本里有没接上的函数：${item.fn}`);
    const actual = replay(decode(item.args) as unknown[]);
    assert.equal(JSON.stringify(encode(actual)), JSON.stringify(item.result));
  });
}
