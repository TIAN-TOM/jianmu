// 复制回答时的文字：界面上显示的时间点按 [分:秒] 写回去，别的字一字不改。样例文字都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerCopyText } from "../../../../src/pages/sidepanel/copy.ts";

test("复制回答：单点时间按 [分:秒] 留在原处", () => {
  assert.equal(answerCopyText("样例里先讲了第一件事 [1:05]，后面又回到这里 [12:30]。"), "样例里先讲了第一件事 [1:05]，后面又回到这里 [12:30]。");
});

test("复制回答：区间时间保留「起-止」", () => {
  assert.equal(answerCopyText("这一段的依据在 [0:10-0:45]。"), "这一段的依据在 [0:10-0:45]。");
});

test("复制回答：超过一小时的分钟数照样保留", () => {
  assert.equal(answerCopyText("结尾在 [75:02]"), "结尾在 [75:02]");
});

test("复制回答：没有时间点的回答原样复制，认不出的方括号不动", () => {
  assert.equal(answerCopyText("样例回答没有时间点。"), "样例回答没有时间点。");
  assert.equal(answerCopyText("写错的时间 [1:75] 和 [注释] 都照原样"), "写错的时间 [1:75] 和 [注释] 都照原样");
});

test("复制回答：多行回答保留换行，去掉首尾空白", () => {
  assert.equal(answerCopyText("\n第一行 [0:03]\n第二行\n"), "第一行 [0:03]\n第二行");
});
