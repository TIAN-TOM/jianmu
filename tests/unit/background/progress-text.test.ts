// 任务进度和收尾的那句话：不传语言是中文，英文每一句都有、没有中文。
import assert from "node:assert/strict";
import { test } from "node:test";
import { progressText } from "../../../src/background/progress-text.ts";

const CJK = /[　-〿一-鿿＀-￯]/;
const sample = (value: string | ((...args: number[]) => string)): string => (typeof value === "function" ? value(2, 5) : value);

test("进度的说法：不传语言和中文一样，英文和中文一样多、没有中文", () => {
  assert.equal(progressText("zh"), progressText("zh"));
  const zh = progressText("zh");
  const en = progressText("en");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.match(sample(zh[key as keyof typeof zh]), CJK, key);
    assert.doesNotMatch(sample(value), CJK, key);
  }
  assert.equal(zh.translateBatch(2, 5), "正在处理 2/5");
  assert.equal(zh.overviewChunk(3, 8), "正在生成 3/8");
  assert.equal(en.translateRetry, "Retrying the parts that failed");
  assert.equal(en.chunkRetry, "Retrying the parts that failed");
  // 分块、分批是内部做法，用户看到的话里不提「块」「批」。
  for (const value of Object.values(zh)) assert.doesNotMatch(sample(value), /[块批]/);
});

test("进度的说法：繁体和简体一样多，每一句都是繁体那份，不是回落的简体", () => {
  const zh = progressText("zh");
  const hant = progressText("zh-Hant");
  assert.deepEqual(Object.keys(hant).sort(), Object.keys(zh).sort());
  for (const [key, value] of Object.entries(hant)) {
    const zhValue = sample(zh[key as keyof typeof zh]);
    const text = sample(value);
    assert.match(text, CJK, key);
    if (zhValue !== text) continue;
    // 简繁写法一样的只有这三句。
    assert.ok(["canceled", "done", "overviewChunk"].includes(key), `${key} 回落成了简体`);
  }
  assert.equal(hant.translateBatch(2, 5), "正在處理 2/5");
  assert.equal(hant.unclaimed, "沒有收到生成請求，已停止");
  assert.equal(hant.verdict, "正在寫一句話結論…");
});
