// 黄金样本重放：样本的 args 原样传给被测函数，输出编码后和 result 逐字节比。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { parseSubtitleFile, isSupportedFileName } from "../../../../src/core/transcript/import-file.ts";
import { guessSubtitleLanguage, isChineseSubtitle } from "../../../../src/core/transcript/language.ts";
import { subtitleTimelineMismatch } from "../../../../src/core/transcript/mismatch.ts";
import {
  buildTranscriptTexts,
  formatTimestamp,
  groupTranscriptEntries,
  limitsForEntries,
  normalizeCaptionText,
  splitOversizedThought,
} from "../../../../src/core/transcript/segment.ts";
import { buildSrt, formatSrtTimestamp } from "../../../../src/core/transcript/srt.ts";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly result: unknown;
}

const FIXTURE = new URL("../../../fixtures/golden/transcript.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: readonly GoldenCase[] };

const REPLAY: Readonly<Record<string, (...args: never[]) => unknown>> = {
  limitsForEntries,
  groupTranscriptEntries,
  buildTranscriptTexts,
  guessSubtitleLanguage,
  normalizeCaptionText,
  splitOversizedThought,
  formatTimestamp,
  formatSrtTimestamp,
  isChineseSubtitle,
  subtitleTimelineMismatch,
  buildSrt,
  parseSubtitleFile,
  isSupportedFileName,
};

// 样本把 JSON 表达不了的值编码成带 $ 的标记，这里互逆地读写。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$undefined" in value) return undefined;
  if ("$number" in value) return Number(value.$number);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map(encode);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, encode(item)]));
}

describe("黄金样本：字幕", () => {
  test("样本覆盖全部用例和函数", () => {
    assert.equal(cases.length, 137);
    assert.deepEqual([...new Set(cases.map((item) => item.fn))].sort(), Object.keys(REPLAY).sort());
  });

  for (const item of cases) {
    test(item.id, () => {
      const replay = REPLAY[item.fn];
      assert.ok(replay, `样本里有没接上的函数：${item.fn}`);
      const actual = replay(...(decode(item.args) as never[]));
      assert.equal(JSON.stringify(encode(actual)), JSON.stringify(item.result));
    });
  }
});
