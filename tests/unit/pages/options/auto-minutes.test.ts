// 设置页「打开就出结论」的分钟数：填的数被规整时就地说改成了多少、为什么，正常值不说。
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_MINUTES_HINT, settleAutoMinutes } from "../../../../src/pages/options/auto-minutes.ts";
import { AUTO_OVERVIEW_MINUTES } from "../../../../src/shared/settings-schema.ts";

const { min, max } = AUTO_OVERVIEW_MINUTES;

test("范围说明取设置结构里的上下限，并说清 0 是什么意思", () => {
  assert.equal(AUTO_MINUTES_HINT, `${min} 到 ${max} 的整数，填 0 时每个视频都生成。`);
});

test("超过上限：存上限，说最多多少", () => {
  assert.deepEqual(settleAutoMinutes("99999"), { minutes: max, note: `最多 ${max} 分钟，已改成 ${max}。` });
});

test("低于下限：存下限，说最少多少", () => {
  assert.deepEqual(settleAutoMinutes("-5"), { minutes: min, note: `最少 ${min} 分钟，已改成 ${min}。` });
});

test("带小数：四舍五入成整数，说只能填整数", () => {
  assert.deepEqual(settleAutoMinutes("2.5"), { minutes: 3, note: "只能填整数，已改成 3。" });
  assert.deepEqual(settleAutoMinutes("7.2"), { minutes: 7, note: "只能填整数，已改成 7。" });
});

test("又超范围又带小数：按范围说", () => {
  assert.deepEqual(settleAutoMinutes("200.5"), { minutes: max, note: `最多 ${max} 分钟，已改成 ${max}。` });
});

test("0 和正常值照存，不提示", () => {
  assert.deepEqual(settleAutoMinutes("0"), { minutes: 0, note: null });
  assert.deepEqual(settleAutoMinutes("25"), { minutes: 25, note: null });
  assert.deepEqual(settleAutoMinutes(String(max)), { minutes: max, note: null });
  assert.deepEqual(settleAutoMinutes(" 30 "), { minutes: 30, note: null });
});

test("清空或填不成数：填回原来的数，不存也不提示", () => {
  assert.equal(settleAutoMinutes(""), null);
  assert.equal(settleAutoMinutes("   "), null);
  assert.equal(settleAutoMinutes("abc"), null);
});
