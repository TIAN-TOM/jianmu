// 黄金样本重放：样本的 args 原样传给被测函数，输出编码后和 result、thrown 逐字节比。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  analysisTimingVariables,
  chunkFailureRanges,
  chunksForFailureRanges,
  estimateOutputTokens,
  groupQuotesIntoChapters,
  mergeAnalyses,
  mergeRetryIntoAnalysis,
  planAnalysisChunks,
  planTranslationBatches,
  truncatedChunkRanges,
  withTruncatedRanges,
} from "../../../../src/core/ai/chunking.ts";
import { parseLooseJson, repairTruncatedJson } from "../../../../src/core/ai/parse.ts";
import { extractPromptSection, fillPromptVariables } from "../../../../src/core/ai/prompt.ts";
import { alignTranslatedSegments, looksLikeTranslation, validateAnalysis } from "../../../../src/core/ai/validate.ts";
import {
  hasAnalysisContent,
  hasOfficialSummaryContent,
  officialVerdictInputs,
  validateVerdict,
  verdictInputs,
} from "../../../../src/core/ai/verdict.ts";
import { noteContextAt } from "../../../../src/core/transcript/note-context.ts";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly note?: string;
  readonly result?: unknown;
  readonly thrown?: unknown;
}

const load = (name: string): GoldenCase[] => {
  const fixture = new URL(`../../../fixtures/golden/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(fixture, "utf8")) as { cases: GoldenCase[] }).cases;
};

const REPLAY: Readonly<Record<string, (...args: never[]) => unknown>> = {
  parseLooseJson,
  repairTruncatedJson,
  planAnalysisChunks,
  validateAnalysis,
  mergeAnalyses,
  groupQuotesIntoChapters,
  chunkFailureRanges,
  truncatedChunkRanges,
  chunksForFailureRanges,
  withTruncatedRanges,
  mergeRetryIntoAnalysis,
  estimateOutputTokens,
  analysisTimingVariables,
  fillPromptVariables,
  extractPromptSection,
  verdictInputs,
  officialVerdictInputs,
  hasAnalysisContent,
  hasOfficialSummaryContent,
  validateVerdict,
  noteContextAt,
  planTranslationBatches,
  looksLikeTranslation,
  alignTranslatedSegments,
};

// 样本把 JSON 表达不了的值编码成带 $ 的标记，这里互逆地读写。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$undefined" in value) return undefined;
  if ("$number" in value) return Number(value.$number);
  if ("$error" in value) {
    const { name: _name, message, ...fields } = value.$error as { name: string; message: string };
    return Object.assign(new Error(message), fields);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === "number" && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map(encode);
  // JSON 报错的文案随 Node 版本变，样本只记类型。
  if (value instanceof SyntaxError) return { $error: { name: value.name } };
  if (value instanceof Error) return { $error: { name: value.name, message: value.message } };
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, encode(item)]));
}

// 写着 note 的用例入参里有回调，样本的说明是前缀「原因：」加错误文案。
const describeFailure = (error: { message?: string } | null | undefined): string => `原因：${error?.message ?? error}`;

function outcomeOf(item: GoldenCase, replay: (...args: never[]) => unknown): unknown {
  const args = decode(item.args) as unknown[];
  if (item.note) args.push(describeFailure);
  try {
    return { result: encode(replay(...(args as never[]))) };
  } catch (error) {
    return { thrown: encode(error) };
  }
}

const SUITES: readonly (readonly [string, number, readonly string[]])[] = [
  ["json-repair", 47, ["parseLooseJson", "repairTruncatedJson"]],
  [
    "analysis",
    99,
    Object.keys(REPLAY).filter((name) => !["parseLooseJson", "repairTruncatedJson"].includes(name)),
  ],
];

for (const [name, count, functions] of SUITES) {
  describe(`黄金样本：${name}`, () => {
    const cases = load(name);

    test("样本覆盖全部用例和函数", () => {
      assert.equal(cases.length, count);
      assert.deepEqual([...new Set(cases.map((item) => item.fn))].sort(), [...functions].sort());
    });

    for (const item of cases) {
      test(`${item.id} ${item.label}`.trim(), () => {
        const replay = REPLAY[item.fn];
        assert.ok(replay, `样本里有没接上的函数：${item.fn}`);
        const expected = "thrown" in item ? { thrown: item.thrown } : { result: item.result };
        assert.equal(JSON.stringify(outcomeOf(item, replay)), JSON.stringify(expected));
      });
    }
  });
}
