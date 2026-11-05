import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLooseJson, repairTruncatedJson } from "../../../../src/core/ai/parse.ts";

test("解析普通 JSON", () => {
  assert.deepEqual(parseLooseJson('{"a":1}'), { a: 1 });
});

test("容忍 markdown 代码围栏", () => {
  assert.deepEqual(parseLooseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseLooseJson('```\n{"a":1}\n```'), { a: 1 });
});

test("容忍 JSON 前后夹带的解释性文字", () => {
  assert.deepEqual(parseLooseJson('好的，这是结果：{"a":1} 希望有帮助'), { a: 1 });
});

test("容忍数组或对象末尾多出来的逗号", () => {
  assert.deepEqual(parseLooseJson('{"a":[1,2,],}'), { a: [1, 2] });
});

test("截断停在逗号后也能补齐：长数组最常见的截断点", () => {
  // 对象数组靠「截到最后大括号」的清洗恰好救场，这里钉住
  assert.deepEqual(parseLooseJson('{"chapters": [{"a": 1}, {"b": 2},'), {
    chapters: [{ a: 1 }, { b: 2 }],
  });
  // 基本类型数组与信封层没有大括号可依托，靠剥悬尾逗号
  assert.deepEqual(parseLooseJson('{"keyQuotes": ["一句", "两句",'), { keyQuotes: ["一句", "两句"] });
  assert.deepEqual(JSON.parse(repairTruncatedJson('{"text": "结论",')), { text: "结论" });
});

test("修复被截断的 JSON：字符串与括号停在半路", () => {
  assert.deepEqual(parseLooseJson('{"answer": "你好 [0:02'), { answer: "你好 [0:02" });
  assert.deepEqual(parseLooseJson('{"a": [1, 2'), { a: [1, 2] });
  assert.deepEqual(parseLooseJson('{"a": {"b": "c"'), { a: { b: "c" } });
});

test("修复被截断的 JSON：末尾孤立反斜杠不转义补上的引号", () => {
  assert.deepEqual(parseLooseJson('{"a": "abc\\'), { a: "abc" });
});

test("修复被截断的 JSON：字符串内的引号转义不受影响", () => {
  assert.deepEqual(parseLooseJson('{"a": "他说 \\"hi\\" 然后'), { a: '他说 "hi" 然后' });
});

test("完全不是 JSON 时才抛错", () => {
  assert.throws(() => parseLooseJson("这不是 JSON"));
});
