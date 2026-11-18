// 整理字幕的本机校验：只许补标点、改几个明显的同音错字；改写、删减、添话、合并或拆分的那一段不采用，照旧显示原文。
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptTidied, alignTidiedSegments } from "../../../../src/core/ai/validate.ts";

const SOURCE = "大家好欢迎回到这个样例频道今天我们来聊一聊怎么读字幕很多视频的字幕是自动识别的";

test("只补标点、空格：采用", () => {
  assert.equal(acceptTidied(SOURCE, "大家好，欢迎回到这个样例频道。今天我们来聊一聊怎么读字幕：很多视频的字幕是自动识别的。"), true);
  assert.equal(acceptTidied("so today we are going", "So today, we are going."), true, "大小写和标点不算改动");
});

test("改一两个同音错字：采用", () => {
  assert.equal(acceptTidied(SOURCE, "大家好，欢迎回到这个样例频道。今天我们来聊一聊怎么读字幕，很多视频的字幕是自动识别的。".replace("识别", "识別")), true);
  assert.equal(acceptTidied("我门今天来聊", "我们今天来聊。"), true, "短段也容一个字");
});

test("改写成自己的话、删掉内容、添话：不采用", () => {
  assert.equal(acceptTidied(SOURCE, "欢迎来到本频道。今天讲讲如何阅读字幕，因为许多视频字幕由机器自动生成。"), false, "改写");
  assert.equal(acceptTidied(SOURCE, "大家好，欢迎回到这个样例频道。"), false, "删掉后半");
  assert.equal(acceptTidied(SOURCE, `${SOURCE}，这一点非常重要，请大家务必记住。`), false, "添话");
  assert.equal(acceptTidied(SOURCE, "，。！"), false, "只剩标点");
  assert.equal(acceptTidied(SOURCE, ""), false);
});

test("一批按 id 对回：改写的段记成 REWRITTEN，漏的、多的、编号不对的不收", () => {
  const sources = [
    { id: "a", text: "大家好欢迎回来" },
    { id: "b", text: "今天聊一聊字幕" },
    { id: "c", text: "我们开始吧" },
  ];
  const parsed = {
    segments: [
      { id: "a", text: "大家好，欢迎回来。" },
      { id: "b", text: "今天我们要讨论的话题是视频字幕的阅读方法。" },
      { id: "x", text: "多出来的一条。" },
    ],
  };
  const { tidied, rejected } = alignTidiedSegments(parsed, sources);
  assert.deepEqual(tidied, { a: "大家好，欢迎回来。" });
  assert.deepEqual(
    rejected.map(({ id, reason }) => [id, reason]),
    [
      ["b", "REWRITTEN"],
      ["x", "UNKNOWN_ID"],
      ["c", "MISSING"],
    ],
  );
});
