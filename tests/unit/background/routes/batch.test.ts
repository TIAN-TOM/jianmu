// 批次端口的消息核对：粗筛两边都能发，本窗口全部生成只收侧边栏；会读标签页地址或发起请求的消息每条重查启用。
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchPort } from "../../../../src/background/routes/batch.ts";
import type { SenderCtx } from "../../../../src/background/senders.ts";

const spec = batchPort({ batch: { handle: async () => {}, leave() {}, state: async () => assert.fail() } }).batch;
const panel: SenderCtx = { kind: "panel" };
const triage: SenderCtx = { kind: "page", page: "triage" };
const video = "bilibili:BV1Sample101:p1";

test("粗筛的消息侧边栏和粗筛页都能发，多带字段、认不出的步骤不收", () => {
  for (const ctx of [panel, triage]) {
    assert.equal(spec.validate({ type: "triage.start", step: "official" }, ctx), true);
    assert.equal(spec.validate({ type: "triage.stop" }, ctx), true);
    assert.equal(spec.validate({ type: "triage.start", step: "everything" }, ctx), false);
    assert.equal(spec.validate({ type: "triage.stop", extra: 1 }, ctx), false);
  }
});

test("本窗口全部生成只收侧边栏，窗口号要是非负整数，单条重来要带视频", () => {
  const messages = [
    { type: "window.count", windowId: 3 },
    { type: "window.start", windowId: 3 },
    { type: "window.stop", windowId: 3 },
    { type: "window.watch", windowId: 3 },
    { type: "window.dismiss", windowId: 3 },
    { type: "window.retry", windowId: 3, video },
  ];
  for (const message of messages) {
    assert.equal(spec.validate(message, panel), true, message.type);
    assert.equal(spec.validate(message, triage), false, `粗筛页：${message.type}`);
  }
  assert.equal(spec.validate({ type: "window.count", windowId: -1 }, panel), false);
  assert.equal(spec.validate({ type: "window.count", windowId: "3" }, panel), false);
  assert.equal(spec.validate({ type: "window.retry", windowId: 3 }, panel), false);
  assert.equal(spec.validate({ type: "window.retry", windowId: 3, video: "不是视频" }, panel), false);
});

test("读标签页地址的清点、确认、单条重来和粗筛开始一步每条重查启用；停止、跟上、收起不查", () => {
  const starts = (message: unknown) => spec.starts(message as never);
  for (const type of ["window.count", "window.start"]) assert.equal(starts({ type, windowId: 1 }), true, type);
  assert.equal(starts({ type: "window.retry", windowId: 1, video }), true);
  assert.equal(starts({ type: "triage.start", step: "list" }), true);
  for (const type of ["window.stop", "window.watch", "window.dismiss"]) assert.equal(starts({ type, windowId: 1 }), false, type);
  assert.equal(starts({ type: "triage.stop" }), false);
});
