// 问答的字幕预算，和问答、概览共用的「输入太长」识别。
import assert from "node:assert/strict";
import { test } from "node:test";
import { isInputTooLong } from "../../../../src/core/ai/too-long.ts";
import { QA_BUDGET_CHARS, QA_FALLBACK_BUDGET_CHARS } from "../../../../src/core/qa/budget.ts";
import { DEFAULT_BUDGET_CHARS } from "../../../../src/core/qa/retrieval.ts";

test("问答默认送约 6 万字，被嫌太长时缩到 1.2 万字", () => {
  assert.equal(QA_BUDGET_CHARS, 60_000);
  assert.equal(DEFAULT_BUDGET_CHARS, QA_BUDGET_CHARS);
  assert.ok(QA_FALLBACK_BUDGET_CHARS < QA_BUDGET_CHARS);
});

test("认得出各家「输入超过上下文」的说法：413，或者 400、422 带着这类说法", () => {
  const tooLong = [
    "This model's maximum context length is 65536 tokens. However, you requested 80000 tokens.",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).",
    "Invalid request: Your request exceeded model token limit: 131072",
    "Range of input length should be [1, 30720]",
    "输入内容超出模型上下文长度限制",
    "prompt 超长",
  ];
  for (const message of tooLong) assert.equal(isInputTooLong({ status: 400, message }), true, message);
  assert.equal(isInputTooLong({ status: 422, message: "context window exceeded" }), true);
  assert.equal(isInputTooLong({ status: 413, message: "" }), true, "413 不看说法");
});

test("别的错误不算：参数不对、内容被拦、限流、服务出错、没有状态码", () => {
  assert.equal(isInputTooLong({ status: 400, message: "Unsupported parameter: 'temperature'" }), false);
  assert.equal(isInputTooLong({ status: 400, message: "content filtered" }), false);
  assert.equal(isInputTooLong({ status: 429, message: "too many tokens per minute" }), false, "限流不缩小重发");
  assert.equal(isInputTooLong({ status: 500, message: "maximum context length" }), false);
  assert.equal(isInputTooLong({ message: "maximum context length" }), false);
  assert.equal(isInputTooLong(null), false);
});
