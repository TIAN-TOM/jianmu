// 侧边栏的整理字幕：打开就取本机存着的结果（不请求模型、不显示进度）；点按钮才带 purpose 发起，从播放位置往后先做；
// 整理后的文字替换原文显示，能切回原始字幕；翻译仍然基于原文；换字幕版本清空；显示和导出跟着切换走。
import assert from "node:assert/strict";
import { test } from "node:test";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { PortHandlers } from "../../../../src/pages/shared/api.ts";
import { linesOf, mainBreaks, srtOf } from "../../../../src/pages/sidepanel/reading.ts";
import { createTidy, createTranslation } from "../../../../src/pages/sidepanel/translate.ts";
import type { TranslateIn } from "../../../../src/shared/messages/translate.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: "BV1Sample001" });

function fakeApi() {
  const posted: TranslateIn[] = [];
  let handlers: PortHandlers<"translate"> | null = null;
  let open = false;
  let connects = 0;
  const api = {
    connect(_name: "translate", next: PortHandlers<"translate">) {
      handlers = next;
      open = true;
      connects += 1;
      return {
        post: (message: TranslateIn) => (open ? (posted.push(message), true) : false),
        close: () => void (open = false),
        isOpen: () => open,
      };
    },
  };
  return { api: api as never, posted, connects: () => connects, emit: (event: Parameters<PortHandlers<"translate">["onEvent"]>[0]) => handlers?.onEvent(event) };
}

test("打开就取本机存着的整理结果：只取存着的，不显示进度，取完不留说明", () => {
  const fake = fakeApi();
  const tidy = createTidy({ api: fake.api });
  tidy.bind(VIDEO, "fp1");
  assert.deepEqual(fake.posted, [{ type: "translate.start", video: VIDEO, storedOnly: true, purpose: "tidy" }]);
  fake.emit({ type: "translate.segments", fingerprint: "fp1", translated: { s0: "大家好。" }, stored: true });
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
  assert.deepEqual(tidy.lines.value, { s0: "大家好。" });
  assert.deepEqual(tidy.state.value, { phase: "idle", done: 0, total: 0, message: "" });
  tidy.bind(VIDEO, "fp1");
  assert.equal(fake.connects(), 1, "同一版不重取");
});

test("点「整理字幕」：带 purpose 从播放位置往后先做，显示进度；能停止；换字幕版本清空", () => {
  const fake = fakeApi();
  const tidy = createTidy({ api: fake.api });
  tidy.bind(VIDEO, "fp1");
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
  tidy.start(42.7);
  assert.deepEqual(fake.posted.at(-1), { type: "translate.start", video: VIDEO, fromSec: 42, purpose: "tidy" });
  assert.equal(tidy.state.value.phase, "running");
  fake.emit({ type: "translate.started", task: {} as never, joined: false, transcript: {} as never, target: "tidy", pending: 3 });
  fake.emit({ type: "translate.segments", fingerprint: "fp1", translated: { s0: "一。", s1: "二。" } });
  assert.deepEqual(tidy.state.value, { phase: "running", done: 2, total: 3, message: "" });
  tidy.stopRunning();
  assert.deepEqual(fake.posted.at(-1), { type: "translate.stop" });
  fake.emit({ type: "translate.done", state: "canceled", totalBatches: 1, failedBatches: 0 });
  assert.equal(tidy.state.value.message, "整理已停止");
  tidy.bind(VIDEO, "fp2");
  assert.deepEqual(tidy.lines.value, {});
});

test("翻译不带 purpose，仍然基于原文；打开视频先只取存着的、接上后台在跑的，再按切换发起；都带上视频所在的标签页", () => {
  const fake = fakeApi();
  const translation = createTranslation({ api: fake.api });
  translation.bind(VIDEO, "fp1", 3);
  assert.deepEqual(fake.posted, [{ type: "translate.start", video: VIDEO, storedOnly: true, tabId: 3 }]);
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
  translation.setMode("bilingual", 0);
  assert.deepEqual(fake.posted.at(-1), { type: "translate.start", video: VIDEO, tabId: 3 });
});

test("打开视频时后台还在跑：接上它，显示进度；做完以后照常收尾", () => {
  const fake = fakeApi();
  const tidy = createTidy({ api: fake.api });
  tidy.bind(VIDEO, "fp1", 3);
  fake.emit({ type: "translate.started", task: {} as never, joined: true, transcript: {} as never, target: "tidy", pending: 10 });
  fake.emit({ type: "translate.segments", fingerprint: "fp1", translated: { s0: "一。" } });
  assert.deepEqual(tidy.state.value, { phase: "running", done: 1, total: 10, message: "" });
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 1, failedBatches: 0 });
  assert.equal(tidy.state.value.phase, "done");
});

test("显示：整理后的替换原文，双语时译文照旧在下面；切回原始字幕（不给整理结果）就是原文；整理过的段不再按行断开", () => {
  const segment = { id: "s0", start: 0, text: "大家好今天聊字幕", texts: ["大家好今天聊字幕"] };
  const tidied = { s0: "大家好，今天聊字幕。" };
  const translated = { s0: "Hi, today we talk about subtitles." };
  assert.deepEqual(linesOf(segment, "original", translated, tidied), { main: "大家好，今天聊字幕。", sub: "" });
  assert.deepEqual(linesOf(segment, "bilingual", translated, tidied), { main: "大家好，今天聊字幕。", sub: translated.s0 });
  assert.deepEqual(linesOf(segment, "translated", {}, tidied), { main: "大家好，今天聊字幕。", sub: "" }, "译文没到时显示整理后的原文");
  assert.deepEqual(linesOf(segment, "original", translated), { main: "大家好今天聊字幕", sub: "" });
  const breaks = new Map([["s0", [3]]]);
  assert.deepEqual(mainBreaks(segment, linesOf(segment, "original", {}, tidied).main, breaks), []);
  assert.deepEqual(mainBreaks(segment, linesOf(segment, "original", {}, {}).main, breaks), [3]);
  const srt = srtOf([segment], [{ start: 0, duration: 2, text: segment.text }], 2, "original", {}, tidied);
  assert.match(srt, /大家好，今天聊字幕。/, "导出跟着显示的走");
});
