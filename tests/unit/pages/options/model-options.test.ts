// 模型候选列表的计算：筛选、标出命中的段、方向键移动、列表朝哪边开。
import assert from "node:assert/strict";
import { test } from "node:test";
import { listSide, matchModels, modelParts, stepModel } from "../../../../src/pages/options/model-options.ts";

const MODELS = ["sample-large-2", "sample-small-2", "vendor/Sample-Vision", "other-model"];

test("筛选：不分大小写，顺序照原来的；框里没字或只有空白就是全部", () => {
  assert.deepEqual(matchModels(MODELS, "SAMPLE"), ["sample-large-2", "sample-small-2", "vendor/Sample-Vision"]);
  assert.deepEqual(matchModels(MODELS, ""), MODELS);
  assert.deepEqual(matchModels(MODELS, "   "), MODELS);
  assert.deepEqual(matchModels(MODELS, "nothing-like-this"), []);
});

test("筛选：空白隔开的几段都出现才算，不看先后", () => {
  assert.deepEqual(matchModels(MODELS, "2 small"), ["sample-small-2"]);
  assert.deepEqual(matchModels(MODELS, "sample other"), []);
});

test("标出命中：原样保留大小写，前后没命中的各成一段", () => {
  assert.deepEqual(modelParts("vendor/Sample-Vision", "sample"), [
    { text: "vendor/", hit: false },
    { text: "Sample", hit: true },
    { text: "-Vision", hit: false },
  ]);
  assert.deepEqual(modelParts("other-model", ""), [{ text: "other-model", hit: false }]);
  assert.deepEqual(modelParts("other-model", "zzz"), [{ text: "other-model", hit: false }]);
});

test("标出命中：几段字各标一处，挨着或叠着的并成一段", () => {
  assert.deepEqual(modelParts("sample-small-2", "2 sample"), [
    { text: "sample", hit: true },
    { text: "-small-", hit: false },
    { text: "2", hit: true },
  ]);
  assert.deepEqual(modelParts("sample-small-2", "samp mple-s"), [
    { text: "sample-s", hit: true },
    { text: "mall-2", hit: false },
  ]);
  assert.deepEqual(modelParts("abc", "abc"), [{ text: "abc", hit: true }]);
});

test("标出命中：拼起来总是原来的名字", () => {
  for (const model of MODELS) {
    for (const query of ["s", "sample 2", "e-", "/", "İ"]) {
      assert.equal(modelParts(model, query).map((part) => part.text).join(""), model);
    }
  }
  assert.deepEqual(modelParts("İstanbul-1", "tan"), [{ text: "İstanbul-1", hit: false }]);
});

test("方向键：到头绕回另一头；还没停在哪一项时向下从第一项起、向上从最后一项起", () => {
  assert.equal(stepModel("ArrowDown", -1, 3), 0);
  assert.equal(stepModel("ArrowUp", -1, 3), 2);
  assert.equal(stepModel("ArrowDown", 2, 3), 0);
  assert.equal(stepModel("ArrowUp", 0, 3), 2);
  assert.equal(stepModel("ArrowDown", 0, 3), 1);
  assert.equal(stepModel("ArrowDown", 7, 3), 0);
  assert.equal(stepModel("ArrowDown", -1, 0), -1);
});

test("列表朝哪边开：下面放得下就朝下，放不下而上面更宽才朝上", () => {
  assert.equal(listSide({ above: 100, below: 300 }, 280), "bottom");
  assert.equal(listSide({ above: 400, below: 120 }, 280), "top");
  assert.equal(listSide({ above: 80, below: 120 }, 280), "bottom");
});
