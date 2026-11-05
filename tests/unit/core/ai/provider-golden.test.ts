// 协议层的黄金样本重放：样本的 args 原样传给被测函数，输出编码后和 result、thrown 逐字节比。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  apiVersionFor,
  buildChatRequest,
  buildModelsRequest,
  canRaiseBudget,
  claudeRequestTraits,
  diagnoseEmptyResponse,
  isOfficialAnthropic,
  isOpenAiReasoningModel,
  isTruncated,
  keyedHttpError,
  openAiModelTraits,
  parseChatResponse,
  parseClaudeModel,
  parseErrorMessage,
  parseModelsResponse,
  redactSecret,
  refusalOf,
  relaxRejectedParams,
  splitSystemMessages,
  vendorExtras,
} from "../../../../src/core/ai/provider/index.ts";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly note?: string;
  readonly result?: unknown;
  readonly thrown?: unknown;
}

const REPLAY: Readonly<Record<string, (...args: never[]) => unknown>> = {
  buildChatRequest,
  buildModelsRequest,
  apiVersionFor,
  isOfficialAnthropic,
  parseClaudeModel,
  claudeRequestTraits,
  isOpenAiReasoningModel,
  openAiModelTraits,
  vendorExtras,
  splitSystemMessages,
  parseChatResponse,
  isTruncated,
  canRaiseBudget,
  refusalOf,
  diagnoseEmptyResponse,
  parseModelsResponse,
  parseErrorMessage,
  keyedHttpError,
  redactSecret,
  relaxRejectedParams,
};

// 样本把 JSON 表达不了的值编码成带 $ 的标记，这里互逆地读写。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$undefined" in value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

const sortedEntries = (value: object): [string, unknown][] =>
  Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (Array.isArray(value)) return value.map(encode);
  if (value instanceof Error) {
    const fields = sortedEntries(value).map(([key, item]) => [key, encode(item)]);
    return { $error: { name: value.name, message: value.message, ...Object.fromEntries(fields) } };
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(sortedEntries(value).map(([key, item]) => [key, encode(item)]));
}

// 写着 note 的用例，第二个入参在样本里只记了字段，调用时要组装成带 status 的 Error。
function argumentsOf(item: GoldenCase): unknown[] {
  const args = decode(item.args) as unknown[];
  if (item.note) {
    const { message, ...fields } = args[1] as { message: string; status: number };
    args[1] = Object.assign(new Error(message), fields);
  }
  return args;
}

function outcomeOf(item: GoldenCase, replay: (...args: never[]) => unknown): unknown {
  try {
    return { result: encode(replay(...(argumentsOf(item) as never[]))) };
  } catch (error) {
    return { thrown: encode(error) };
  }
}

const { cases } = JSON.parse(
  readFileSync(new URL("../../../fixtures/golden/provider.json", import.meta.url), "utf8"),
) as { cases: GoldenCase[] };

test("协议样本覆盖全部用例和函数", () => {
  assert.equal(cases.length, 611);
  assert.deepEqual([...new Set(cases.map((item) => item.fn))].sort(), Object.keys(REPLAY).sort());
});

for (const item of cases) {
  test(`协议样本 ${item.id} ${item.label}`.trim(), () => {
    const replay = REPLAY[item.fn];
    assert.ok(replay, `样本里有没接上的函数：${item.fn}`);
    const expected = "thrown" in item ? { thrown: item.thrown } : { result: item.result };
    assert.equal(JSON.stringify(outcomeOf(item, replay)), JSON.stringify(expected));
  });
}
