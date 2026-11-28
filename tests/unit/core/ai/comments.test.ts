// 评论区怎么说：准备发给模型的评论、核对模型写回来的那一块、读存着的那一块。样例都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { commentMaterial, commentViewOf, COMMENT_SEND_CHARS, COMMENT_SEND_MAX, hasContact, storedCommentView } from "../../../../src/core/ai/comments.ts";
import { validateVerdict } from "../../../../src/core/ai/verdict.ts";

const sample = (text: string, likes = 1, pinned = false) => ({ text, likes, pinned });

test("带联系方式或链接的评论认得出：邮箱、网址、手机号、带号码的社交账号", () => {
  for (const text of ["联系 sample@example.com", "看 https://example.com/x", "去 www.example.cn 看", "电话 13812345678", "加微信 sample_id01", "qq: 123456789", "+61 400 000 000"]) {
    assert.equal(hasContact(text), true, text);
  }
  assert.equal(hasContact("LINE ID: sample42"), true);
  for (const text of ["12:30 那里讲错了", "第 3 章最好", "赞了 100000 次", "1.5 倍速看正好", "The timeline clearly explains the sequence", "Great pipeline demo", "qq 音乐里也有这首"]) {
    assert.equal(hasContact(text), false, text);
  }
});

test("发给模型的评论：跳过空的和带联系方式的，截短，编上序号，置顶的标出来，不带昵称", () => {
  const material = commentMaterial([sample("  置顶：前五分钟是背景  ", 12, true), sample("   "), sample("加微信 sample_id01 领资料", 99), sample("后半段的对比很清楚", 230), sample("长".repeat(COMMENT_SEND_CHARS + 20), 3)]);
  assert.deepEqual(material.kept.map((comment) => comment.text.slice(0, 12)), ["置顶：前五分钟是背景", "后半段的对比很清楚", "长".repeat(12)]);
  assert.equal(material.kept[2]?.text.length, COMMENT_SEND_CHARS);
  assert.equal(material.text.split("\n")[0], "[1] 置顶 赞 12：置顶：前五分钟是背景");
  assert.equal(material.text.split("\n")[1], "[2] 赞 230：后半段的对比很清楚");
  const longTail = commentMaterial([sample(`${"长".repeat(COMMENT_SEND_CHARS - 10)}联系 sample@example.com`)]);
  assert.deepEqual(longTail.kept, [], "联系方式在截掉的那一截里也整条跳过");
  const many = commentMaterial(Array.from({ length: COMMENT_SEND_MAX + 5 }, (_, index) => sample(`评论${index}`)));
  assert.equal(many.kept.length, COMMENT_SEND_MAX);
});

const KEPT = [sample("前五分钟是背景", 12, true), sample("后半段的对比很清楚", 230), sample("12:30 的数字写错了", 88)];
const STARTS = [0, 300, 750];

test("模型写回来的那一块：要点按序号挂上原评论，章节标记对上现有章节才留", () => {
  const view = commentViewOf(
    {
      tag: "有人指出错误",
      line: "  多数人觉得后半段值得看，也有人指出 12:30 的数字有误  ",
      points: [
        { text: "有评论指出 12:30 的数字写错了", refs: [3, 3, 9] },
        { text: "这一条挂不上原评论", refs: [0, 4] },
        { text: "后半段讲得清楚", refs: ["2"] },
      ],
      marks: [
        { at: "12:30", kind: "有误" },
        { at: "12:30", kind: "有误" },
        { at: "5:00", kind: "精彩" },
        { at: "0:00", kind: "好笑" },
      ],
    },
    KEPT,
    STARTS,
    "zh",
  );
  assert.deepEqual(view, {
    tag: "有人指出错误",
    line: "多数人觉得后半段值得看，也有人指出 12:30 的数字有误",
    points: [
      { text: "有评论指出 12:30 的数字写错了", quotes: [KEPT[2]] },
      { text: "后半段讲得清楚", quotes: [KEPT[1]] },
    ],
    marks: [
      { start: 300, kind: "精彩" },
      { start: 750, kind: "有误" },
    ],
  });
});

test("标签不在几种里就整块不要；没有这一块也是空", () => {
  assert.equal(commentViewOf({ tag: "还行", line: "x", points: [], marks: [] }, KEPT, STARTS, "zh"), null);
  assert.equal(commentViewOf(undefined, KEPT, STARTS, "zh"), null);
  assert.deepEqual(commentViewOf({ tag: "评论还少" }, KEPT, STARTS, "zh"), { tag: "评论还少", line: "", points: [], marks: [] });
});

test("存着的那一块：照形状核一遍；读存着的结论时留下，读模型新写的结论时不从这里收", () => {
  const stored = { tag: "有争议", line: "两派意见", points: [{ text: "有人说好", quotes: [{ text: "讲得好", likes: 5, pinned: false, author: "x" }] }, { text: "没有原评论", quotes: [] }], marks: [{ start: 300, kind: "可跳过" }, { start: -1, kind: "有误" }] };
  const view = storedCommentView(stored);
  assert.deepEqual(view, { tag: "有争议", line: "两派意见", points: [{ text: "有人说好", quotes: [{ text: "讲得好", likes: 5, pinned: false }] }], marks: [{ start: 300, kind: "可跳过" }] });
  const verdict = { summary: "讲了什么", value: "", verdict: 3, reason: "理由", comments: stored };
  assert.deepEqual(validateVerdict(verdict, { stored: true, lang: "zh" })?.comments, view);
  assert.equal(validateVerdict(verdict, { lang: "zh" })?.comments, undefined, "模型新写的由调用方按发出去的评论另外核对");
  assert.equal(validateVerdict({ ...verdict, comments: { tag: "还行" } }, { stored: true, lang: "zh" })?.comments, undefined);
});
