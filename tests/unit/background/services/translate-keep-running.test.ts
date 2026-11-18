// 翻译和整理字幕点了就做完：重开面板接上后台在跑的进度，接上以后点停止照样停；发起的标签页换了视频或关掉时停下；
// 服务说额度用完或密钥不对时，后面的批次不再发，任务按失败收尾并说清原因。
import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSLATION_BATCH_MAX_SEGMENTS } from "../../../../src/core/ai/chunking.ts";
import type { CompletionRequest } from "../../../../src/core/ai/transport/index.ts";
import { cue, echo, page, transcriptView, translateHarness, VIDEO } from "../../../helpers/translate-service.ts";

/** 三批满的加一段。 */
const MANY = Array.from({ length: TRANSLATION_BATCH_MAX_SEGMENTS * 3 + 1 }, (_, index) => cue(index * 10, `第${index + 1}句`));
const TAB = 7;

test("重开面板：只取存着的那一下碰上后台在跑，接上它；已经做完的批次先交回，之后的照常推过来", async () => {
  const view = await transcriptView(MANY);
  const h = translateHarness(view, { concurrency: 1 });
  const release = h.fake.hold("rewrite");
  const first = page("panel-1");
  const running = h.translate(first);
  assert.ok(await h.requested(1));
  h.service.leave(first.id);

  const back = page("panel-2");
  await h.service.start(VIDEO, { origin: "user", listener: back, storedOnly: true });
  release();
  const started = back.of("translate.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]?.joined, true);
  assert.equal(back.of("translate.done").length, 0, "还在跑，不说做完了");
  await running;
  assert.equal(back.of("translate.done")[0]?.state, "completed", "接上以后收到收尾");
  assert.equal(Object.keys(back.translated()).length, MANY.length);
});

test("接上以后点停止：照样停下，在途的一起中止", async () => {
  const view = await transcriptView(MANY);
  const h = translateHarness(view, { concurrency: 1 });
  const release = h.fake.hold("rewrite");
  const first = page("panel-1");
  const running = h.translate(first);
  assert.ok(await h.requested(1));
  h.service.leave(first.id);
  const back = page("panel-2");
  await h.service.start(VIDEO, { origin: "user", listener: back, storedOnly: true });
  h.service.stop(back.id);
  release();
  await running;
  assert.equal(h.requests(), 1, "后面的不再发");
  assert.equal(back.of("translate.done")[0]?.state, "canceled");
});

test("发起的标签页换了视频或关掉：停下；换的是同一个视频的地址不停", async () => {
  for (const change of ["other", "closed"] as const) {
    const view = await transcriptView(MANY);
    const h = translateHarness(view, { concurrency: 1 });
    const release = h.fake.hold("rewrite");
    const panel = page("panel");
    const running = h.service.start(VIDEO, { origin: "user", listener: panel, tabId: TAB });
    assert.ok(await h.requested(1));
    h.service.tabChanged(TAB, "https://www.bilibili.com/video/BV1Sample000?t=30");
    h.service.tabChanged(TAB + 1, null);
    assert.equal(h.tasks.list()[0]?.state, "running", "同一个视频、别的标签页都不算");
    h.service.tabChanged(TAB, change === "other" ? "https://www.bilibili.com/video/BV1Sample999" : null);
    release();
    await running;
    assert.equal(h.requests(), 1, change);
    assert.equal(panel.of("translate.done")[0]?.state, "canceled", change);
  }
});

test("额度用完或密钥不对：后面的批次不再发，不补轮，任务按失败收尾并说清原因", async () => {
  for (const [label, error] of [
    ["quota", Object.assign(new Error("余额不足"), { code: "AI_RATE_LIMITED", status: 429, quotaExhausted: true })],
    ["key", Object.assign(new Error("密钥不对"), { code: "INVALID_AI_KEY", status: 401 })],
  ] as const) {
    const view = await transcriptView(MANY);
    let sent = 0;
    const reply = (request: CompletionRequest): string => {
      sent += 1;
      if (sent === 2) throw error;
      return echo()(request);
    };
    const h = translateHarness(view, { concurrency: 1, reply });
    const panel = page("panel");
    await h.translate(panel);
    assert.equal(h.requests(), 2, `${label}：出错那批之后不再发`);
    assert.equal(h.timers.pending(), 0, `${label}：不等着补轮`);
    const done = panel.of("translate.done")[0];
    assert.equal(done?.state, "failed", label);
    assert.equal(done?.failure?.code, error.code, label);
    assert.equal(Object.keys(panel.translated()).length, TRANSLATION_BATCH_MAX_SEGMENTS, `${label}：出错前做完的那批照常交回`);
  }
});
