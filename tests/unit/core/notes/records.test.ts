import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeAnalysisFailures,
  noteList,
  videoIdOf,
  type Derived,
  type GenInfo,
  type TranscriptRef,
} from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const GEN: GenInfo = { feature: "overview", promptVersion: "1", model: "sample-model", effort: "off" };
const VIDEO = videoKey({ platform: "youtube", videoId: "sample_id" });
const TRANSCRIPT: TranscriptRef = { video: VIDEO, kind: "human", lang: "zh-CN", fingerprint: "0123456789abcdef" };

test("失败区间：缺的字段补成能用的值，结束不早于开始，原因截到一句话", () => {
  assert.deepEqual(normalizeAnalysisFailures(null), []);
  assert.deepEqual(normalizeAnalysisFailures([{ index: "2", startSeconds: 90.9, endSeconds: 30, reason: "  超时  " }, null]), [
    { index: 2, startSeconds: 90, endSeconds: 90, reason: "超时" },
    { index: 0, startSeconds: 0, endSeconds: 0 },
  ]);
  const [long] = normalizeAnalysisFailures([{ reason: "长".repeat(300) }]);
  assert.equal(long?.reason?.length, 200);
  assert.deepEqual(normalizeAnalysisFailures([{ startSeconds: Infinity }]), []);
});

test("视频编号从键里取，键认不出时原样用键", () => {
  assert.equal(videoIdOf("bilibili:BV1Sample000:p2"), "BV1Sample000");
  assert.equal(videoIdOf("youtube:sample_id"), "sample_id");
  assert.equal(videoIdOf("认不出"), "认不出");
  assert.equal(videoIdOf(undefined), "");
});

test("笔记列表只留对象", () => {
  assert.deepEqual(noteList(undefined), []);
  assert.deepEqual(noteList([null, { text: "留下" }, undefined]), [{ text: "留下" }]);
});

test("依据：旧备份导入的依据未知，可以没有生成配置", () => {
  const bare: Derived = { basis: { source: "legacy-unknown" } };
  const hinted: Derived = { basis: { source: "legacy-unknown", hint: "official-summary" } };
  const known: Derived = { basis: { source: "legacy-unknown" }, gen: GEN };
  assert.deepEqual([bare, hinted, known].map((derived) => derived.gen?.model), [undefined, undefined, "sample-model"]);
});

test("依据：依据已知的结果必须带生成配置，读的时候先判断有没有", () => {
  const fresh: Derived = { basis: { source: "transcript", transcript: TRANSCRIPT }, gen: GEN };
  // @ts-expect-error 依据字幕的结果要记生成配置
  const transcript: Derived = { basis: { source: "transcript", transcript: TRANSCRIPT } };
  // @ts-expect-error 依据官方总结的结果要记生成配置
  const summary: Derived = { basis: { source: "official-summary", video: VIDEO, fingerprint: "0123456789abcdef" } };
  // @ts-expect-error 只依据标题和简介的结果要记生成配置
  const title: Derived = { basis: { source: "title-description", video: VIDEO, fingerprint: "0123456789abcdef" } };
  // @ts-expect-error gen 可能缺，先判断再读
  const unchecked = (derived: Derived): string => derived.gen.model;
  assert.throws(() => unchecked(transcript), TypeError);
  assert.deepEqual([fresh, transcript, summary, title].map((derived) => derived.gen?.model ?? "未知"), ["sample-model", "未知", "未知", "未知"]);
});
