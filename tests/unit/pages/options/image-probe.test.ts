// 设置页的看图检测：能看、不能看、没探成，各给一句话。
import assert from "node:assert/strict";
import { test } from "node:test";
import { fail, ok } from "../../../../src/core/errors.ts";
import { probeFrameImage } from "../../../../src/pages/options/image-probe.ts";

const apiReplying = (reply: unknown) => ({ send: (async () => reply) as never });

test("能看、不能看、没探成：状态行各一句，不能看时说去哪儿换", async () => {
  const text = () => "连不上。";
  assert.deepEqual(await probeFrameImage(apiReplying(ok({ model: "m1", imageInput: true })), text), { text: "画面分析（m1）能看图。", tone: "ok" });
  const blind = await probeFrameImage(apiReplying(ok({ model: "m2", imageInput: false })), text);
  assert.equal(blind.tone, "warn");
  assert.match(blind.text, /m2.*不能看图.*按功能选模型/);
  assert.deepEqual(await probeFrameImage(apiReplying(fail("AI_NETWORK_ERROR")), text), { text: "画面分析：没探成，连不上。", tone: "error" });
});
