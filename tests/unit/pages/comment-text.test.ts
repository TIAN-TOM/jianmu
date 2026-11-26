// 评论区的界面文案和取数（PRD F23）：标签和章节标记按界面语言写，认不出的照原样；三种语言条数和顺序对得上；结论里的那一块照形状再核一遍。
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_TAGS, MARK_KINDS } from "../../../src/core/ai/comments.ts";
import { COMMENT_TEXT_EN, COMMENT_TEXT_ZH, commentNotes, commentViewOfVerdict, markName, tagName } from "../../../src/pages/shared/ui/comment-text.ts";
import { COMMENT_TEXT_HANT } from "../../../src/pages/shared/ui/comment-text-hant.ts";

test("三种语言的标签和章节标记，条数都和本机认得的几种一样", () => {
  for (const text of [COMMENT_TEXT_ZH, COMMENT_TEXT_EN, COMMENT_TEXT_HANT]) {
    assert.equal(text.tags.length, COMMENT_TAGS.length);
    assert.equal(text.marks.length, MARK_KINDS.length);
  }
  assert.deepEqual(COMMENT_TEXT_ZH.tags, COMMENT_TAGS, "简体就是标签本身");
});

test("标签和章节标记按语言写，认不出的照原样", () => {
  assert.equal(tagName("说是标题党", COMMENT_TEXT_EN), "Called clickbait");
  assert.equal(tagName("说是标题党", COMMENT_TEXT_HANT), "說是標題黨");
  assert.equal(tagName("还行", COMMENT_TEXT_EN), "还行");
  assert.equal(markName("有误", COMMENT_TEXT_ZH), "评论说有误");
  assert.equal(markName("可跳过", COMMENT_TEXT_EN), "Comments say skip");
  assert.equal(COMMENT_TEXT_EN.likes(1), "1 like");
  assert.equal(COMMENT_TEXT_EN.quotes(2), "2 comments");
});

test("章节旁边的标记和章节一一对应，同一章有几种就都写上，没有的是 null", () => {
  const view = { tag: "有争议", line: "", points: [], marks: [{ start: 0, kind: "精彩" }, { start: 300, kind: "有误" }, { start: 300, kind: "可跳过" }] };
  assert.deepEqual(commentNotes(view, [0, 150, 300], COMMENT_TEXT_ZH), ["评论说精彩", null, "评论说有误 · 评论说可跳过"]);
  assert.deepEqual(commentNotes(null, [0, 150], COMMENT_TEXT_ZH), [null, null]);
});

test("结论里的评论区那一块照形状再核一遍：没有、形状不对时是 null", () => {
  assert.equal(commentViewOfVerdict(undefined), null);
  assert.equal(commentViewOfVerdict({ summary: "s" }), null);
  assert.equal(commentViewOfVerdict({ comments: { tag: "还行" } }), null);
  assert.deepEqual(commentViewOfVerdict({ comments: { tag: "好评居多", line: "大家喜欢", points: [], marks: [] } }), { tag: "好评居多", line: "大家喜欢", points: [], marks: [] });
});
