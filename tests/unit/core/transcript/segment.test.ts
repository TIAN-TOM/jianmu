import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTranscriptTexts,
  CJK_LIMITS,
  formatTimestamp,
  groupTranscriptEntries,
  LATIN_LIMITS,
  limitsForEntries,
  normalizeCaptionText,
  splitOversizedThought,
} from "../../../../src/core/transcript/segment.ts";

const AI_CAPTIONS = [
  "今天我们来讲一下这个算法",
  "它的核心思想其实很简单",
  "就是把问题拆成更小的子问题",
  "然后逐个击破再合并结果",
  "这样时间复杂度会明显下降",
  "接下来我们看一个具体例子",
  "假设有一个长度为八的数组",
  "我们先把它平均分成两半",
  "分别对左右两边排序",
  "最后再做一次归并操作",
].map((text, index) => ({ text, start: index * 3, duration: 3 }));

test("按 CJK 占比自动选择分段阈值", () => {
  assert.equal(limitsForEntries(AI_CAPTIONS), CJK_LIMITS);
  assert.equal(limitsForEntries([{ text: "\u3400".repeat(40), start: 0, duration: 2 }]), CJK_LIMITS);
  assert.equal(
    limitsForEntries([{ text: "this is an english caption line", start: 0 }]),
    LATIN_LIMITS,
  );
  assert.equal(limitsForEntries([]), LATIN_LIMITS);
});

test("归一化清掉多余空白与中文字符间的空格", () => {
  assert.equal(normalizeCaptionText("  你 好   世界  "), "你好世界");
  assert.equal(normalizeCaptionText("hello   world"), "hello world");
  assert.equal(normalizeCaptionText("你好 ，世界"), "你好，世界");
  assert.equal(normalizeCaptionText(null), "");
});

test("超长无标点内容按上限硬切，但优先切在标点或词边界", () => {
  assert.deepEqual(splitOversizedThought("abcdefghij", 20), ["abcdefghij"]);

  const withComma = splitOversizedThought("aaaaaaaaaaaa，bbbbbbbbbbbb", 16);
  assert.equal(withComma[0], "aaaaaaaaaaaa，");
  assert.equal(withComma[1], "bbbbbbbbbbbb");

  const noBoundary = splitOversizedThought("啊".repeat(50), 20);
  assert.ok(noBoundary.every((part) => part.length <= 20));
  assert.equal(noBoundary.join(""), "啊".repeat(50));
});

test("无标点的 AI 字幕在原始字幕行边界切分，不会切碎词语", () => {
  const segments = groupTranscriptEntries(AI_CAPTIONS);

  assert.ok(segments.length >= 2, "十条字幕应该分成多段");
  const entryTexts = AI_CAPTIONS.map((entry) => entry.text);
  for (const segment of segments) {
    assert.ok(
      entryTexts.some((text) => segment.text.endsWith(text)),
      `段落应结束于某条原始字幕的末尾：${segment.text}`,
    );
    assert.ok(segment.text.length <= CJK_LIMITS.maxChars * 1.2);
  }

  // 分段不能丢字
  assert.equal(segments.map((s) => s.text).join(""), entryTexts.join(""));
});

test("每段保留贡献首个文字的那条字幕的时间戳", () => {
  const segments = groupTranscriptEntries(AI_CAPTIONS);
  assert.equal(segments[0]?.start, 0);
  segments.slice(1).forEach((segment, index) => {
    assert.ok(segment.start > (segments[index]?.start ?? Infinity), "时间戳应递增");
  });
});

test("段落 id 稳定可用于翻译缓存键", () => {
  const first = groupTranscriptEntries(AI_CAPTIONS);
  const second = groupTranscriptEntries(AI_CAPTIONS);
  assert.deepEqual(
    first.map((s) => s.id),
    second.map((s) => s.id),
  );
  assert.match(first[0]?.id ?? "", /^segment-0-0$/);
});

test("有标点的中文字幕在句末切分", () => {
  const entries = [
    { text: "第一句话讲的是背景，", start: 0, duration: 3 },
    { text: "它决定了后面所有的设计取舍。", start: 3, duration: 3 },
    { text: "第二句话开始讲实现细节，", start: 6, duration: 3 },
    { text: "这里有三个关键点需要注意。", start: 9, duration: 3 },
    { text: "第三句话聊的是性能开销，", start: 12, duration: 3 },
    { text: "主要瓶颈出现在内存分配上。", start: 15, duration: 3 },
    { text: "最后一句话做个总结收尾，", start: 18, duration: 3 },
    { text: "希望这个例子对你有帮助。", start: 21, duration: 3 },
  ];
  const segments = groupTranscriptEntries(entries);
  assert.ok(segments.length >= 2);
  for (const segment of segments) {
    assert.match(segment.text, /[。！？]$/, "应该切在句号后");
  }
});

test("英文字幕按拉丁阈值分段", () => {
  const entries = [
    { text: "The first idea here is deceptively simple.", start: 0, duration: 4 },
    { text: "You split the problem into halves.", start: 4, duration: 4 },
    { text: "Then you solve each half on its own.", start: 8, duration: 4 },
    { text: "Finally you merge the two sorted halves.", start: 12, duration: 4 },
    { text: "That is the whole trick behind merge sort.", start: 16, duration: 4 },
  ];
  const segments = groupTranscriptEntries(entries);
  assert.ok(segments.length >= 1);
  for (const segment of segments) {
    assert.ok(segment.text.length <= LATIN_LIMITS.maxChars * 1.2);
    assert.doesNotMatch(segment.text, /\s{2,}/);
  }
});

test("空输入返回空数组", () => {
  assert.deepEqual(groupTranscriptEntries([]), []);
  assert.deepEqual(groupTranscriptEntries(null), []);
  assert.deepEqual(groupTranscriptEntries([{ text: "   ", start: 0 }]), []);
});

test("时间戳格式化为 M:SS", () => {
  assert.equal(formatTimestamp(0), "0:00");
  assert.equal(formatTimestamp(95), "1:35");
  assert.equal(formatTimestamp(3671), "61:11");
  assert.equal(formatTimestamp(-5), "0:00");
});

test("同时产出纯文本与带时间戳的文本视图", () => {
  const { plain, timestamped } = buildTranscriptTexts([
    { text: "开场白", start: 0, duration: 2 },
    { text: "正文内容", start: 95, duration: 3 },
    { text: "   ", start: 100, duration: 1 },
  ]);

  assert.equal(plain, "开场白 正文内容");
  assert.equal(timestamped, "[0:00] 开场白\n[1:35] 正文内容");
});
