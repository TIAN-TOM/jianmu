// 侧边栏的整理字幕：打开就取本机存着的结果（不请求模型、不显示进度）；点按钮才带 purpose 发起，从播放位置往后先做；
// 整理后的文字替换原文显示，能切回原始字幕；翻译仍然基于原文；换字幕版本清空；显示和导出跟着切换走。
import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred } from "../../../helpers/deferred.ts";
import { SAMPLE_VIDEO_KEY as VIDEO } from "../../../helpers/sample-videos.ts";
import { stillFalse, until } from "../../../helpers/wait-until.ts";
import type { TranscriptMode, TranscriptModeRequest } from "../../../../src/shared/messages/transcript.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { PortHandlers } from "../../../../src/pages/shared/api.ts";
import { linesOf, mainBreaks, srtOf } from "../../../../src/pages/sidepanel/reading.ts";
import { createTidy, createTranslation } from "../../../../src/pages/sidepanel/translate.ts";
import type { TranslateIn } from "../../../../src/shared/messages/translate.ts";


function fakeApi(send: (type: string, req: TranscriptModeRequest) => Promise<{ ok: true; value: { mode: TranscriptMode } }> = async () => ({ ok: true, value: { mode: "original" } })) {
  const posted: TranslateIn[] = [];
  let handlers: PortHandlers<"translate"> | null = null;
  let open = false;
  let connects = 0;
  const api = {
    send,
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
  assert.equal(tidy.state.value.message, "整理停了");
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

test("同一个视频开在两个标签页里，切过去以后发起的算现在这个标签页的", () => {
  const fake = fakeApi();
  const tidy = createTidy({ api: fake.api });
  tidy.bind(VIDEO, "fp1", 3);
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
  tidy.bind(VIDEO, "fp1", 9);
  assert.equal(fake.connects(), 1, "同一版不重取");
  tidy.start(0);
  assert.deepEqual(fake.posted.at(-1), { type: "translate.start", video: VIDEO, purpose: "tidy", tabId: 9 });
});

test("打开视频时只取存着的那一下还没回来，用户就切到了双语：取完以后接着发起翻译，不会被吞掉", () => {
  const fake = fakeApi();
  const translation = createTranslation({ api: fake.api });
  translation.bind(VIDEO, "fp1", 3);
  translation.setMode("bilingual", 42);
  assert.equal(fake.posted.length, 1, "还在取，先记下");
  assert.equal(translation.mode.value, "bilingual");
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
  assert.deepEqual(fake.posted.at(-1), { type: "translate.start", video: VIDEO, fromSec: 42, tabId: 3 });
  assert.equal(translation.state.value.phase, "running");
});

test("只取存着的那一下碰上后台在跑：接上了，期间点的开始不用再发", () => {
  const fake = fakeApi();
  const translation = createTranslation({ api: fake.api });
  translation.bind(VIDEO, "fp1", 3);
  translation.setMode("translated", 0);
  fake.emit({ type: "translate.started", task: {} as never, joined: true, transcript: {} as never, target: "en", pending: 5 });
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 1, failedBatches: 0 });
  assert.equal(fake.posted.length, 1, "只发过那一次取存着的");
});

test("恢复译文只取已经存好的，缺的段落仍显示原文；主动再选译文才开始翻译", async () => {
  const fake = fakeApi(async () => ({ ok: true, value: { mode: "translated" } }));
  const translation = createTranslation({ api: fake.api });
  translation.bind(VIDEO, "fp1");
  fake.emit({ type: "translate.segments", fingerprint: "fp1", translated: { s0: "Moonlight" }, stored: true });
  fake.emit({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
  assert.ok(await until(() => translation.mode.value === "translated"));
  const row = (id: string) => linesOf({ id, start: 0, text: "月光", texts: ["月光"] }, translation.mode.value, translation.lines.value);
  assert.equal(row("s0").main, "Moonlight");
  assert.equal(row("s1").main, "月光");
  assert.deepEqual(fake.posted, [{ type: "translate.start", video: VIDEO, storedOnly: true }]);
  translation.setMode("translated", 17);
  assert.deepEqual(fake.posted.at(-1), { type: "translate.start", video: VIDEO, fromSec: 17 });
});

test("旧视频和主动改选前的恢复回复都不能覆盖当前选择", async () => {
  const other = videoKey({ platform: "youtube", videoId: "sample" });
  const old = deferred();
  const current = deferred();
  const saved: TranscriptModeRequest[] = [];
  const fake = fakeApi(async (_type, req) => {
    if (req.mode) {
      saved.push(req);
      return { ok: true, value: { mode: req.mode } };
    }
    await (req.video === VIDEO ? old : current).promise;
    return { ok: true, value: { mode: "translated" } };
  });
  const translation = createTranslation({ api: fake.api });
  translation.bind(VIDEO, "one");
  translation.bind(other, "two");
  old.resolve();
  assert.ok(await stillFalse(() => translation.mode.value !== "original"));
  translation.setMode("original");
  current.resolve();
  assert.ok(await stillFalse(() => translation.mode.value !== "original"));
  assert.deepEqual(saved, [{ video: other, mode: "original" }]);
  assert.ok(fake.posted.every((message) => message.type === "translate.start" && message.storedOnly));
});
