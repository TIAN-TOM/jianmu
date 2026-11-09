// 播放页记笔记的路由：只收内容脚本，字段只有视频和时间，视频以发送方标签页地址上的为准，消息里的视频对不上就拒；
// 扩展页面存笔记不受这套限制，可以带整理好的正文。播放页来的笔记每分钟只润色几条。
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAYER_NOTE_POLISH_LIMIT } from "../../../../src/background/limits.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import type { NoteListView, NoteSaveView } from "../../../../src/shared/messages/notes.ts";
import { siteRules } from "../../../../src/sites/rules.ts";
import { avPageUrl, avVideoId, listPageUrl, videoPageUrl } from "../../../helpers/bilibili-pages.ts";
import { senders, watchUrl } from "../../../helpers/chrome.ts";
import { chatReply } from "../../../helpers/fake-model-service.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";
import { until } from "../../../helpers/wait-until.ts";

const PLAYING: VideoKey = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });
const REAL_RULES = Object.values(siteRules);
const FORBIDDEN = { ok: false, code: "FORBIDDEN" };

const atTime = (overrides: Record<string, unknown> = {}) => ({ video: PLAYING, atSec: 42, ...overrides });

async function notesOf(bg: ReturnType<typeof studyBackground>): Promise<[VideoKey, number][]> {
  const listed = await bg.send<NoteListView>("notes.list", {});
  assert.ok(listed.ok, JSON.stringify(listed));
  return listed.value.notes.map((note) => [note.video, note.atSec]);
}

test("内容脚本在当前视频当前时间点记笔记照常成功", async () => {
  const bg = studyBackground({ withoutAi: true });
  const response = await bg.send<NoteSaveView>("notes.saveAtTime", atTime(), senders.content(watchUrl(SAMPLE_ID)));
  assert.ok(response.ok, JSON.stringify(response));
  assert.deepEqual(await notesOf(bg), [[PLAYING, 42]]);
});

test("合集播放页（地址带视频号参数）上的内容脚本也能记笔记", async () => {
  const bg = studyBackground({ withoutAi: true, siteRules: REAL_RULES });
  const response = await bg.send("notes.saveAtTime", atTime(), senders.content(listPageUrl(SAMPLE_ID)));
  assert.ok(response.ok, JSON.stringify(response));
  assert.deepEqual(await notesOf(bg), [[PLAYING, 42]]);
});

test("内容脚本记的笔记与所在标签页不是同一个视频时拒绝", async () => {
  const bg = studyBackground({ withoutAi: true, siteRules: REAL_RULES });
  assert.deepEqual(await bg.send("notes.saveAtTime", atTime(), senders.content(videoPageUrl("BV1Sample002"))), FORBIDDEN, "视频对不上");
  assert.deepEqual(await bg.send("notes.saveAtTime", atTime(), senders.content(videoPageUrl(SAMPLE_ID, 2))), FORBIDDEN, "分 P 对不上");
  // 地址拿不到时宁可不记。
  const { url: _url, ...withoutUrl } = { ...senders.content(videoPageUrl(SAMPLE_ID)), tab: { id: 7, windowId: 1 } };
  assert.deepEqual(await bg.send("notes.saveAtTime", atTime(), withoutUrl), { ok: false, code: "INVALID_REQUEST" }, "没有地址");
  assert.deepEqual(await notesOf(bg), []);
  assert.equal(bg.site.calls.length, 0, "拒掉的不取字幕");
});

test("av 号老地址的播放页记笔记：后台和内容脚本一样把 av 号换成 BV 号再核对", async () => {
  const bg = studyBackground({ withoutAi: true, siteRules: REAL_RULES });
  const converted = videoKey({ platform: "bilibili", videoId: avVideoId(), segment: 1 });
  const response = await bg.send("notes.saveAtTime", atTime({ video: converted }), senders.content(avPageUrl()));
  assert.ok(response.ok, JSON.stringify(response));
  assert.deepEqual(await bg.send("notes.saveAtTime", atTime(), senders.content(avPageUrl())), FORBIDDEN, "换算出来的编号对不上照样拒绝");
  assert.deepEqual(await notesOf(bg), [[converted, 42]]);
});

test("内容脚本记笔记的请求结构不对时拒绝", async () => {
  const bg = studyBackground({ withoutAi: true });
  const content = senders.content(watchUrl(SAMPLE_ID));
  const malformed: Record<string, unknown> = {
    "夹带正文（会跳过字幕原文直接入库）": atTime({ text: "伪造的笔记" }),
    多余字段: atTime({ noteId: "note_1" }),
    视频键认不出: atTime({ video: "bilibili:BV123:p1" }),
    视频键带多余字符: atTime({ video: `${PLAYING}x` }),
    分P为0: atTime({ video: PLAYING.replace(":p1", ":p0") }),
    缺少时间: { video: PLAYING },
    缺少视频: { atSec: 42 },
    时间是字符串: atTime({ atSec: "42" }),
    时间为负: atTime({ atSec: -1 }),
    时间不是有限数: atTime({ atSec: null }),
    不是对象: [PLAYING, 42],
  };
  for (const [label, req] of Object.entries(malformed)) {
    assert.deepEqual(await bg.send("notes.saveAtTime", req, content), { ok: false, code: "INVALID_REQUEST" }, label);
  }
  assert.deepEqual(await notesOf(bg), []);
  // 扩展页面发不了这一条：视频要从发送方所在标签页的地址认。
  assert.deepEqual(await bg.send("notes.saveAtTime", atTime(), senders.panel()), FORBIDDEN);
});

test("扩展页面保存笔记不受内容脚本那套限制，可以带整理好的正文", async () => {
  const bg = studyBackground({ withoutAi: true });
  const response = await bg.send<NoteSaveView>("notes.save", atTime({ text: "概览里的金句" }), senders.panel());
  assert.ok(response.ok, JSON.stringify(response));
  const listed = await bg.send<NoteListView>("notes.list", { video: PLAYING }, senders.options());
  assert.equal(listed.ok && listed.value.notes[0]?.text, "概览里的金句");
  // 内容脚本不能借扩展页面这条带正文。
  assert.deepEqual(await bg.send("notes.save", atTime({ text: "伪造" }), senders.content(watchUrl(SAMPLE_ID))), FORBIDDEN);
});

test("播放页记的笔记每分钟最多润色 6 次，超出的只存原文", async () => {
  const cues = Array.from({ length: 10 }, (_, index) => ({ start: index * 10, duration: 10, text: `第${index}句` }));
  const bg = studyBackground({ cues, handler: () => chatReply(JSON.stringify({ quote: "润色后的笔记" })) });
  // 页面借按钮骗点击：用户每点一下视频就是一条笔记。
  const responses: NoteSaveView[] = [];
  for (let index = 0; index < 8; index += 1) {
    const response = await bg.send<NoteSaveView>("notes.saveAtTime", atTime({ atSec: index * 10 }), senders.content(watchUrl(SAMPLE_ID)));
    assert.ok(response.ok, JSON.stringify(response));
    responses.push(response.value);
  }
  assert.equal(PLAYER_NOTE_POLISH_LIMIT, 6);
  assert.deepEqual(
    responses.map((response) => (response.polishLimited ? "limited" : response.note.polishing ? "polishing" : "plain")),
    ["polishing", "polishing", "polishing", "polishing", "polishing", "polishing", "limited", "limited"],
  );
  bg.fake.timers.fire(0);
  assert.ok(await until(() => bg.ai.posts().length === 6));
  assert.ok(await until(async () => (await bg.send<NoteListView>("notes.list", {})).ok));
  assert.equal(bg.ai.posts().length, 6, "超出的没发润色请求");

  // 侧边栏存的笔记不占播放页的名额。
  const panel = await bg.send<NoteSaveView>("notes.save", atTime({ atSec: 95 }), senders.panel());
  assert.ok(panel.ok && panel.value.note.polishing === true);
});
