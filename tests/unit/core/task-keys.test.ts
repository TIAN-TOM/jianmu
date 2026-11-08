// 任务的两种键：互斥键按种类和视频，翻译再分目标语言；等价键对内容规范化后取哈希，写法不同、内容相同算一个。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Basis } from "../../../src/core/notes/records.ts";
import { equivalenceKey, mutexKey, type EquivalenceInput } from "../../../src/core/task-keys.ts";
import { videoKey } from "../../../src/core/video-ref.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment: 1 });
const OTHER = videoKey({ platform: "youtube", videoId: "tube-sample" });
const GEN = { feature: "analysis", baseUrl: "https://ai.example.test/v1", model: "model-a", effort: "off", promptVersion: "p1" } as const;
const BASIS: Basis = { source: "transcript", transcript: { video: VIDEO, kind: "human", lang: "zh-CN", fingerprint: "f1" } };

test("互斥键是种类加视频键，翻译另加目标语言；问答、划词解释、画面解释没有互斥键", () => {
  assert.equal(mutexKey({ kind: "overview", video: VIDEO }), `overview:${VIDEO}`);
  assert.equal(mutexKey({ kind: "triage-verdict", video: VIDEO }), `triage-verdict:${VIDEO}`);
  assert.equal(mutexKey({ kind: "translate", video: VIDEO, lang: "en" }), `translate:${VIDEO}:en`);
  assert.notEqual(mutexKey({ kind: "translate", video: VIDEO, lang: "en" }), mutexKey({ kind: "translate", video: VIDEO, lang: "ja" }));
  for (const kind of ["qa", "explain", "frame-explain"] as const) assert.equal(mutexKey({ kind, video: VIDEO }), null, kind);
});

test("等价键：键的先后、没写的可选项不影响结果，内容相同就相同", async () => {
  const base: EquivalenceInput = { kind: "qa", video: VIDEO, basis: BASIS, input: { question: "讲了什么", range: [1, 2] }, gen: GEN };
  const reordered: EquivalenceInput = {
    gen: { promptVersion: "p1", effort: "off", model: "model-a", baseUrl: "https://ai.example.test/v1", feature: "analysis" },
    input: { range: [1, 2], question: "讲了什么" },
    basis: BASIS,
    video: VIDEO,
    kind: "qa",
    lang: undefined,
  };
  const key = await equivalenceKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await equivalenceKey(reordered), key);
});

test("等价键：种类、视频、依据、功能输入、生成配置任一项不同就不同；依据没定和定了不同", async () => {
  const base: EquivalenceInput = { kind: "overview", video: VIDEO, basis: BASIS, gen: GEN };
  const key = await equivalenceKey(base);
  const variants: EquivalenceInput[] = [
    { ...base, kind: "verdict" },
    { ...base, video: OTHER },
    { ...base, basis: { ...BASIS, transcript: { ...BASIS.transcript, fingerprint: "f2" } } as Basis },
    { kind: "overview", video: VIDEO, gen: GEN },
    { ...base, input: { retry: [[0, 60]] } },
    { ...base, gen: { ...GEN, model: "model-b" } },
    { ...base, gen: { ...GEN, baseUrl: "https://other.example.test/v1" } },
    { ...base, gen: { ...GEN, effort: "high" } },
    { ...base, gen: { ...GEN, promptVersion: "p2" } },
  ];
  const keys = await Promise.all(variants.map((variant) => equivalenceKey(variant)));
  for (const [index, other] of keys.entries()) assert.notEqual(other, key, JSON.stringify(variants[index]));
  assert.equal(new Set(keys).size, keys.length);
});
