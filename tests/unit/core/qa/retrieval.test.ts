import assert from "node:assert/strict";
import { test } from "node:test";
import { clickableTimestamps } from "../../../../src/core/qa/citations.ts";
import { questionTerms, selectContext } from "../../../../src/core/qa/retrieval.ts";

// 与分块输出同构的最小块。
function chunk(index: number, startSeconds: number, text?: string, endSeconds?: number) {
  return {
    index,
    startSeconds,
    endSeconds: endSeconds ?? startSeconds + 60,
    text: text || `内容块 ${index}`,
  };
}

function makeChunks(count: number, text = "常规讲解内容") {
  return Array.from({ length: count }, (_, index) =>
    chunk(index, index * 120, `${text}${index}`.repeat(20)),
  );
}

test("questionTerms：中文切 bigram、拉丁按词、停用词摘除", () => {
  const terms = questionTerms("什么是反向传播？How does backprop work?");
  assert.equal(terms.includes("什么"), false, "功能词不参检");
  assert.equal(terms.includes("如何"), false);
  assert.equal(terms.includes("how"), false);
  assert.ok(terms.includes("反向"), "中文 bigram");
  assert.ok(terms.includes("向传"));
  assert.ok(terms.includes("backprop"));
});

test("questionTerms：孤立单字保留，纯标点返回空", () => {
  assert.deepEqual(questionTerms("光"), ["光"]);
  assert.deepEqual(questionTerms("？？？！！！"), []);
});

test("短字幕走 full 模式整份直送", () => {
  const chunks = makeChunks(3);
  const result = selectContext({ chunks, question: "讲了什么主题" });
  assert.equal(result.mode, "full");
  assert.equal(result.chunks.length, 3);
  assert.deepEqual(result.timeRange, { min: 0, max: 300, ranges: [{ min: 0, max: 300 }] });
});

test("长字幕打分筛选，命中块的相邻块一并带上且按时间排序", () => {
  // 6 块 × 约 2200 字 > 默认预算 12000，触发 selected。
  const chunks = Array.from({ length: 6 }, (_, index) =>
    chunk(index, index * 120, `块${index} ${"字".repeat(2200)}`),
  );
  // 只有第 3 块（index=2）含关键词。
  chunks[2]!.text += " 反向传播的核心推导";

  const result = selectContext({
    chunks,
    question: "反向传播是怎么推导的",
    budgetChars: 12_000,
  });

  assert.equal(result.mode, "selected");
  const indexes = result.chunks.map((c) => c.index);
  assert.deepEqual(indexes, [1, 2, 3], "命中块 + 前后邻居");
  // 末块的上界取下一块的起点：endSeconds 是末段的起点，会少算末段那几秒。
  assert.equal(result.timeRange?.min, 120);
  assert.equal(result.timeRange?.max, 480);
});

test("selected 模式的引用区间只覆盖送进模型的块，不因视频总长放宽到片尾", () => {
  const chunks = Array.from({ length: 6 }, (_, index) =>
    chunk(index, index * 120, `块${index} ${"字".repeat(2200)}`),
  );
  chunks[2]!.text += " 反向传播的核心推导";

  const result = selectContext({
    chunks,
    question: "反向传播是怎么推导的",
    totalDurationSeconds: 900,
  });

  assert.equal(result.mode, "selected");
  assert.equal(result.timeRange?.min, 120);
  assert.equal(result.timeRange?.max, 480, "上界是第 4 块的起点，不是视频总长 900");
});

test("选中的块不相邻时，中间没送进模型的那段也不算合法引用", () => {
  const chunks = Array.from({ length: 8 }, (_, index) =>
    chunk(index, index * 120, `块${index} ${"字".repeat(1500)}`),
  );
  chunks[1]!.text += " 反向传播";
  chunks[6]!.text += " 反向传播";

  const result = selectContext({
    chunks,
    question: "反向传播",
    totalDurationSeconds: 1000,
  });

  assert.equal(result.mode, "selected");
  assert.deepEqual(result.chunks.map((c) => c.index), [0, 1, 2, 5, 6, 7]);
  const clickable = clickableTimestamps("[1:00] [7:00] [12:00] [16:00]", result.timeRange);
  assert.deepEqual([...clickable], [60, 720, 960], "7:00 落在没选的第 4、5 块之间");
});

test("full 模式有视频总长时，末块的上界仍以总长封顶", () => {
  const chunks = makeChunks(3);
  const result = selectContext({ chunks, question: "讲了什么主题", totalDurationSeconds: 400 });
  assert.equal(result.mode, "full");
  assert.equal(result.timeRange?.min, 0);
  assert.equal(result.timeRange?.max, 400);
});

test("相邻命中块的后邻居也会带上：跨块话题的续块不丢", () => {
  const chunks = Array.from({ length: 6 }, (_, index) =>
    chunk(index, index * 120, `块${index} ${"字".repeat(2200)}`),
  );
  // 话题横跨块边界：index=1、2 相邻都命中。若按「前一块已选」抄近路
  // 跳过 +1 侧，第 3 块永远进不了上下文，答案引用会过不了区间闸门。
  chunks[1]!.text += " 反向传播的核心推导";
  chunks[2]!.text += " 反向传播的收敛性分析";

  const result = selectContext({
    chunks,
    question: "反向传播",
    budgetChars: 12_000,
  });

  assert.equal(result.mode, "selected");
  assert.deepEqual(
    result.chunks.map((c) => c.index),
    [0, 1, 2, 3],
    "命中 1、2，两侧邻居 0 与 3 全部带上",
  );
});

test("预算超限时从尾部裁剪，至少保留一块", async () => {
  const chunks = [
    chunk(0, 0, "命中关键词 " + "字".repeat(5000)),
    chunk(1, 120, "也命中 关键词 " + "字".repeat(5000)),
    chunk(2, 240, "还命中 关键词 " + "字".repeat(5000)),
  ];
  const result = selectContext({
    chunks,
    question: "关键词",
    maxChunks: 6,
    budgetChars: 8000,
  });
  assert.equal(result.mode, "selected");
  assert.ok(result.chunks.length >= 1);
  assert.ok(
    result.chunks.reduce((sum, c) => sum + c.text.length, 0) <= 8000 ||
      result.chunks.length === 1,
    "裁剪后总量应回到预算内（单块超预算时至少保留整块）",
  );
});

test("全部得分为零时进入骨架模式，时间戳原样保留", () => {
  // 总字数要超过预算才会走到打分；零内容词问题得分为零 → 骨架。
  const chunks = Array.from({ length: 4 }, (_, i) =>
    chunk(i, i * 120, `[${Math.floor(i * 120 / 60)}:${String((i * 120) % 60).padStart(2, "0")}] 无关句子${i}${"字".repeat(3200)}`),
  );
  const result = selectContext({
    chunks,
    question: "总结一下整体脉络",
  });

  assert.equal(result.mode, "skeleton");
  assert.equal(result.chunks.length, 4);
  assert.ok(result.chunks.every((c) => c.text.startsWith("[")), "骨架保留时间戳");
  assert.deepEqual(result.timeRange, { min: 0, max: 420, ranges: [{ min: 0, max: 420 }] });
});

test("章节加权：正文没直接命中、章节标题命中的块胜出", () => {
  const chunks = makeChunks(8).map((c) => ({
    ...c,
    text: "与问题无关的正文".repeat(100),
  }));
  // 生产数据按时间升序；样例保持一致。
  const chapters = [
    { title: "其它章节", summary: "", timestampSeconds: 0 },
    { title: "梯度消失与反向传播", summary: "", timestampSeconds: 360 },
  ];

  const result = selectContext({
    chunks,
    question: "梯度消失怎么解决",
    chapters,
    budgetChars: 4000,
  });

  assert.equal(result.mode, "selected");
  const indexes = result.chunks.map((c) => c.index);
  assert.ok(indexes.includes(3), "章节「梯度消失」覆盖的块应入选");
  assert.ok(!indexes.includes(0), "无关章节的块不应占位");
});

test("空问句或空块时安全返回", () => {
  const empty = selectContext({ chunks: [], question: "" });
  assert.equal(empty.mode, "full");
  assert.deepEqual(empty.chunks, []);
});
