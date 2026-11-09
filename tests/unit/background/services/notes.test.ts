// 笔记服务：先存字幕原文，回复之后才在后台润色；同一视频同一秒去重，去重之后才问润色名额；编辑、删除、按视频列出。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRateLimit } from "../../../../src/background/limits.ts";
import { NOTE_QUOTE } from "../../../../src/core/ai/schemas.ts";
import type { Result } from "../../../../src/core/errors.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { NoteItemView, NoteListView, NoteSaveView } from "../../../../src/shared/messages/notes.ts";
import { senders, watchUrl } from "../../../helpers/chrome.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { chatReply } from "../../../helpers/fake-model-service.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";
import { cue, INTERVAL, SECOND_PART, START, studyHarness, TUBE, VIDEO, type StudyHarnessOptions } from "../../../helpers/study-service.ts";
import { until } from "../../../helpers/wait-until.ts";

const SENTENCES = { [VIDEO]: [cue(0, "第一句话"), cue(10, "第二句话"), cue(20, "第三句话")] };

const notesHarness = (options: StudyHarnessOptions = {}) =>
  studyHarness({ transcripts: SENTENCES, ai: { replies: { notes: JSON.stringify({ quote: "润色后的话" }) } }, ...options });

const saved = (result: Result<NoteSaveView>): NoteSaveView => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

function note(id: string, overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id,
    kind: "note",
    origin: "user",
    video: VIDEO,
    snapshot: { title: "标题", author: "UP 主" },
    atSec: 5,
    text: `笔记 ${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const stored = async (h: ReturnType<typeof notesHarness>): Promise<NoteRecord[]> => h.noteDriver.getAll();

// ============================================================
// 保存
// ============================================================

test("保存笔记：正文来自命中那句，同秒重复保存去重", async () => {
  const h = notesHarness({ aiReady: false });
  const first = saved(await h.notes.save({ video: VIDEO, atSec: 12 }));
  assert.match(first.note.text, /第二句话/);
  assert.equal(first.note.quote, "第二句话", "命中那句原样存一份快照");
  assert.equal(first.note.url, `https://video.example/${SAMPLE_ID}?p=1&t=12`, "链接按视频和时间现拼");
  assert.deepEqual(first.note.snapshot, { title: "标题", author: "UP 主" });

  const again = saved(await h.notes.save({ video: VIDEO, atSec: 12.7 }));
  assert.equal(again.duplicate, true);
  assert.equal(again.note.id, first.note.id);
  assert.equal((await stored(h)).length, 1);
  assert.equal(h.broadcasts.filter((message) => message.type === "notes.changed").length, 1, "已经有了的不再通知刷新");
});

test("没有可用的字幕时明确报错", async () => {
  const h = notesHarness({ transcripts: { [VIDEO]: [] } });
  assert.deepEqual(await h.notes.save({ video: VIDEO, atSec: 5 }), { ok: false, code: "NO_TRANSCRIPT" });
  const locked = notesHarness({ transcripts: { [VIDEO]: "NEED_LOGIN" } });
  assert.deepEqual(await locked.notes.save({ video: VIDEO, atSec: 5 }), { ok: false, code: "NEED_LOGIN" }, "取字幕的错照实交回");
  assert.deepEqual(await stored(h), []);
});

test("配置可用时先落原始字幕再后台润色；不可用则直接落定", async () => {
  const h = notesHarness();
  const pending = saved(await h.notes.save({ video: VIDEO, atSec: 11 }));
  assert.equal(pending.note.polishing, true, "页面据此显示润色中");
  assert.equal(h.fake.count("notes"), 0, "回复之前不发润色请求");
  assert.equal(h.timers.due(0), 1, "润色排在回复之后");
  assert.match((await stored(h))[0]?.text ?? "", /第二句话/, "原文已经存下");
  await h.flushPolish();
  const [polished] = await stored(h);
  assert.equal(polished?.text, "润色后的话");
  assert.equal(polished?.quote, "第二句话", "原句快照不跟着改");
  assert.deepEqual(polished?.derived, {
    basis: { source: "transcript", transcript: { video: VIDEO, kind: "human", lang: "zh-CN", fingerprint: "fp-第一句话|第二句话|第三句话" } },
    gen: { feature: "notes", promptVersion: "fake-prompt", model: "fake-model", effort: "off" },
  });
  const listed = await h.notes.list(VIDEO);
  assert.equal(listed.ok && listed.value.notes[0]?.polishing, undefined, "润色完不再标着");

  const plain = notesHarness({ aiReady: false });
  const direct = saved(await plain.notes.save({ video: VIDEO, atSec: 11 }));
  assert.equal(direct.note.polishing, undefined);
  assert.equal(plain.timers.pending(), 0, "没有排着的润色");
});

test("手动提供的文字不再过模型（概览里存为笔记的路径）", async () => {
  const h = notesHarness();
  const result = saved(await h.notes.save({ video: VIDEO, atSec: 3, text: "  已经写好的话 " }));
  assert.equal(result.note.text, "已经写好的话");
  assert.equal(result.note.polishing, undefined);
  assert.equal("quote" in result.note, false);
  await h.flushPolish();
  assert.equal(h.fake.count(), 0);
});

test("限频：窗口内最多放行 limit 次，窗口滑过去再放行", () => {
  const clock = { now: 0 };
  const take = createRateLimit({ limit: 2, windowMs: 1000, now: () => clock.now });
  assert.equal(take(), true);
  clock.now = 400;
  assert.equal(take(), true);
  assert.equal(take(), false, "第三次超出");
  clock.now = 999;
  assert.equal(take(), false, "第一次还在窗口里");
  clock.now = 1000;
  assert.equal(take(), true, "第一次滑出窗口，空出一个名额");
  assert.equal(take(), false);
});

test("润色名额用完时只存原文、不润色，并告诉调用方", async () => {
  const h = notesHarness();
  let asked = 0;
  const mayPolish = () => {
    asked += 1;
    return false;
  };
  const result = saved(await h.notes.save({ video: VIDEO, atSec: 12 }, { mayPolish }));
  assert.equal(result.polishLimited, true);
  assert.equal(result.note.polishing, undefined, "页面不会一直显示润色中");
  assert.match(result.note.text, /第二句话/);
  assert.equal(asked, 1);
  assert.equal(h.timers.pending(), 0, "没有排着的润色");
  await nextTurn();
  assert.equal(h.fake.count(), 0, "没有发润色请求");
});

test("润色名额只在真要润色的新笔记上消耗：重复、手写正文、没配好 AI 都不占", async () => {
  const h = notesHarness();
  let asked = 0;
  const mayPolish = () => {
    asked += 1;
    return true;
  };
  const first = saved(await h.notes.save({ video: VIDEO, atSec: 12 }, { mayPolish }));
  assert.equal(first.polishLimited, undefined);
  assert.equal(first.note.polishing, true);
  assert.equal(asked, 1);
  await h.flushPolish();
  assert.equal(h.fake.count("notes"), 1, "有名额时照常润色");

  await h.notes.save({ video: VIDEO, atSec: 12 }, { mayPolish });
  await h.notes.save({ video: VIDEO, atSec: 20, text: "写好的话" }, { mayPolish });
  const offline = notesHarness({ aiReady: false });
  await offline.notes.save({ video: VIDEO, atSec: 12 }, { mayPolish });
  assert.equal(asked, 1);
});

test("笔记润色按笔记正文的 schema 请求结构化输出", async () => {
  const h = notesHarness();
  await h.notes.save({ video: VIDEO, atSec: 11 });
  await h.flushPolish();
  assert.equal(h.fake.count("notes"), 1);
  assert.equal(h.fake.calls[0]?.request.responseFormat, NOTE_QUOTE);
  assert.equal(h.fake.calls[0]?.request.maxTokens, 512);
});

test("播放页记笔记后的后台润色：回复消息之后才发请求，请求挂着时同样保活", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const bg = studyBackground({ handler: async () => (await gate.promise, chatReply(JSON.stringify({ quote: "润色后的话" }))) });
  const playing = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });
  const result = await bg.send<NoteSaveView>("notes.saveAtTime", { video: playing, atSec: 1 }, senders.content(watchUrl(SAMPLE_ID)));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.note.polishing, true, "先存原文，润色在后台跑");
  assert.equal(bg.ai.posts().length, 0, "回复的时候润色请求还没发");

  bg.fake.timers.fire(0);
  assert.ok(await until(() => bg.ai.posts().length === 1), "润色请求发出去了");
  bg.fake.timers.fire(INTERVAL);
  assert.equal(bg.fake.calls.pings, 1, "请求挂着时照样保活");

  gate.resolve();
  assert.ok(
    await until(async () => {
      const listed = await bg.send<NoteListView>("notes.list", { video: playing });
      return listed.ok && listed.value.notes[0]?.text === "润色后的话" && listed.value.notes[0].polishing === undefined;
    }),
  );
  assert.equal(bg.fake.timers.due(INTERVAL), 0, "润色结束就停");
});

test("润色途中用户改了正文：润色回来不覆盖；润色失败留原文，日志只记类别", async () => {
  const h = notesHarness();
  const release = h.fake.hold("notes");
  const first = saved(await h.notes.save({ video: VIDEO, atSec: 11 }));
  h.timers.fire(0);
  assert.ok(await until(() => h.fake.count("notes") === 1));
  assert.ok((await h.notes.update(first.note.id, "我自己写的")).ok);
  release();
  await h.flushPolish();
  assert.equal((await stored(h))[0]?.text, "我自己写的");

  const broken = notesHarness({ ai: { replies: { notes: new Error("服务挂了，密钥 sk-secret") } } });
  const kept = saved(await broken.notes.save({ video: VIDEO, atSec: 11 }));
  await broken.flushPolish();
  assert.equal((await stored(broken))[0]?.text, kept.note.text);
  assert.deepEqual(broken.logs, [{ level: "warn", label: "笔记润色失败，保留原文" }]);
});

test("等润色的工夫清除了本机数据：润色不写回，笔记也不被重建", async () => {
  const h = notesHarness();
  const release = h.fake.hold("notes");
  await h.notes.save({ video: VIDEO, atSec: 11 });
  h.timers.fire(0);
  assert.ok(await until(() => h.fake.count("notes") === 1));
  await h.guard.clear("all", () => h.noteDriver.clear());
  release();
  await h.flushPolish();
  assert.deepEqual(await stored(h), []);
});

test("YouTube 视频本机还没有字幕时只存时间点：不读字幕、不润色", async () => {
  const h = notesHarness({ transcripts: {} });
  const result = saved(await h.notes.save({ video: TUBE, atSec: 30 }));
  assert.equal(result.note.text, "");
  assert.equal(result.note.atSec, 30);
  assert.equal(result.note.polishing, undefined);
  assert.deepEqual(h.reads(), { ensure: 0, cacheOnly: 1 }, "只看本机缓存，不替页面去读");

  const cached = notesHarness({ transcripts: { [TUBE]: [cue(25, "缓存里的字幕")] } });
  const withText = saved(await cached.notes.save({ video: TUBE, atSec: 30 }));
  assert.match(withText.note.text, /缓存里的字幕/);
  assert.equal(withText.note.polishing, true, "本机已有字幕时照常润色");
});

// ============================================================
// 编辑和列出
// ============================================================

test("新存和编辑过的笔记都不再带版本号和内容来源", async () => {
  const h = notesHarness({ aiReady: false });
  const first = saved(await h.notes.save({ video: VIDEO, atSec: 5 }));
  for (const field of ["revision", "contentSource", "pending", "rawText"]) {
    assert.equal(Object.hasOwn(first.note, field), false, field);
  }
  const updated = await h.notes.update(first.note.id, "  新正文  ");
  assert.ok(updated.ok);
  assert.equal(updated.value.note.text, "新正文");
  for (const field of ["revision", "contentSource", "pending", "rawText"]) {
    assert.equal(Object.hasOwn(updated.value.note, field), false, field);
  }
  assert.deepEqual(await h.notes.update(first.note.id, "  "), { ok: false, code: "EMPTY_NOTE" });
});

test("本视频笔记按视频键精确关联，分 P 之间互相隔离", async () => {
  const h = notesHarness({
    notes: [note("p1", { video: VIDEO, text: "第一 P", createdAt: 1000 }), note("p2", { video: SECOND_PART, text: "第二 P", createdAt: 1001 })],
  });
  const second = await h.notes.list(SECOND_PART);
  assert.deepEqual(second.ok && second.value.notes.map((item: NoteItemView) => item.id), ["p2"]);
  const all = await h.notes.list();
  assert.deepEqual(all.ok && all.value.notes.map((item: NoteItemView) => item.id), ["p2", "p1"], "不带视频时列出全部，最新的在前");
});

test("笔记正文可以更新，并记录更新时间；库里带着多余字段的老笔记也照常能改，多余字段不往外带", async () => {
  const legacy = { ...note("note_1", { text: "旧正文" }), revision: 4, contentSource: "ai", aiDraft: { text: "过期候选", basedOnRevision: 4 } } as NoteRecord;
  const h = notesHarness({ notes: [legacy] });
  const result = await h.notes.update("note_1", "  修改后的正文  ");
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.note.text, "修改后的正文");
  assert.equal(result.value.note.updatedAt, START);
  assert.ok(result.value.note.updatedAt >= result.value.note.createdAt);
  for (const field of ["revision", "contentSource", "aiDraft"]) assert.equal(Object.hasOwn(result.value.note, field), false, field);
  const [row] = await stored(h);
  assert.equal(row?.text, "修改后的正文");
  assert.equal(row && Object.hasOwn(row, "revision"), false, "写回时也不带");
  assert.ok(h.broadcasts.some((message) => message.type === "notes.changed" && message.video === VIDEO));
});

test("空正文和不存在的笔记不会被写入", async () => {
  const h = notesHarness({ notes: [note("note_1", { text: "保留" })] });
  assert.deepEqual(await h.notes.update("note_1", "  "), { ok: false, code: "EMPTY_NOTE" });
  assert.deepEqual(await h.notes.update("missing", "新正文"), { ok: false, code: "NOTE_NOT_FOUND" });
  assert.deepEqual(await h.notes.update("note_1", "长".repeat(3001)), { ok: false, code: "NOTE_TOO_LONG" });
  assert.equal((await stored(h))[0]?.text, "保留");
});

test("超过 100 条后继续保存，不再静默删除最旧笔记", async () => {
  const existing = Array.from({ length: 100 }, (_, index) => note(`note_${index}`, { atSec: index, createdAt: 1000 + index }));
  const h = notesHarness({ notes: existing, aiReady: false });
  assert.ok((await h.notes.save({ video: VIDEO, atSec: 101, text: "第 101 条" })).ok);
  const rows = await stored(h);
  assert.equal(rows.length, 101);
  assert.ok(rows.some((row) => row.id === "note_0"));
});

const quotaError = (message: string) => Object.assign(new Error(message), { name: "QuotaExceededError" });

function failingOnce(error: Error): StudyHarnessOptions["wrapNotes"] {
  let armed = true;
  return (inner) => ({
    ...inner,
    async write(change) {
      if (armed) {
        armed = false;
        throw error;
      }
      return inner.write(change);
    },
  });
}

test("带着整理好的正文存笔记：不要求读字幕，没登录时照样存下，不向平台读", async () => {
  const h = studyHarness({ transcripts: { [VIDEO]: "NEED_LOGIN" } });
  const result = await h.notes.save({ video: VIDEO, atSec: 30, text: "从概览里摘的一句" });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.value.note.text, "从概览里摘的一句");
  assert.deepEqual(h.reads(), { ensure: 0, cacheOnly: 1 }, "只看本机有的视频信息");
  assert.deepEqual(await h.notes.save({ video: VIDEO, atSec: 40 }), { ok: false, code: "NEED_LOGIN" }, "不带正文的要字幕原文，照旧报要登录");
});

test("存储空间不足时明确报错，并保留已有笔记", async () => {
  const existing = Array.from({ length: 100 }, (_, index) => note(`note_${index}`, { atSec: index, createdAt: 1000 + index }));
  const h = notesHarness({ notes: existing, aiReady: false, wrapNotes: failingOnce(new Error("QUOTA_BYTES quota exceeded")) });
  assert.deepEqual(await h.notes.save({ video: VIDEO, atSec: 101, text: "放不下的笔记" }), { ok: false, code: "STORAGE_FULL" });
  assert.equal((await stored(h)).length, 100);
});

// 数据库写满时异常的名字固定，文案由浏览器定，不一定提到配额：磁盘满时只说磁盘满了，有时一个字都没有。
test("存储写满按错误名认：文字里没有 quota 也报 STORAGE_FULL", async () => {
  for (const error of [quotaError("Encountered disk full while committing transaction."), quotaError(""), new Error("QUOTA_BYTES quota exceeded")]) {
    const h = notesHarness({ aiReady: false, wrapNotes: failingOnce(error) });
    assert.deepEqual(await h.notes.save({ video: VIDEO, atSec: 3, text: "笔记" }), { ok: false, code: "STORAGE_FULL" }, error.message);
  }
  const other = notesHarness({ aiReady: false, wrapNotes: failingOnce(new Error("boom")) });
  await assert.rejects(other.notes.save({ video: VIDEO, atSec: 3, text: "笔记" }), /boom/, "别的写入错误交给路由按后台出错回");
});

test("删除笔记只删这一条，删完通知页面刷新；已经没有的照常回成功", async () => {
  const h = notesHarness({ notes: [note("note_1"), note("note_2", { atSec: 6 })] });
  assert.deepEqual(await h.notes.remove("note_1"), { ok: true, value: {} });
  assert.deepEqual((await stored(h)).map((row) => row.id), ["note_2"]);
  assert.deepEqual(await h.notes.remove("note_1"), { ok: true, value: {} });
  assert.equal(h.broadcasts.filter((message) => message.type === "notes.changed").length, 1);
});
