// 导入的字幕文件：存进 imports 仓库，没点名语言的读取先用它，排在读视频信息之前，不向平台发任何请求；
// 导入和移除只作废缓存里的字幕，作废不掉就撤回；同一视频的导入、移除排队，做着的时候读取先等。
// 站点是替身，缓存和导入字幕用真实仓储加内存驱动。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OFFICIAL_GRACE_MS } from "../../../../../src/background/services/transcript/official.ts";
import type { ImportRecord } from "../../../../../src/background/stores/imports.ts";
import { describe } from "../../../../../src/core/errors.ts";
import { isChineseSubtitle } from "../../../../../src/core/transcript/language.ts";
import { IMPORTED_SUBTITLE_LABEL } from "../../../../../src/core/transcript/sources.ts";
import type { ObjectStoreDriver } from "../../../../../src/platform/idb.ts";
import type { TranscriptReply } from "../../../../../src/shared/messages/transcript.ts";
import type { Cue } from "../../../../../src/sites/types.ts";
import { deferred, type Deferred } from "../../../../helpers/deferred.ts";
import { failed } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, harness, KEY, REF, sampleInfo, texts, view, type Row } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const SRT = ["1", "00:00:01,000 --> 00:00:04,000", "导入的第一句", "", "2", "00:00:05,000 --> 00:00:08,000", "导入的第二句", ""].join("\n");
const FILE = { name: "课程.srt", text: SRT };
const IMPORTED_TEXTS = "导入的第一句\n导入的第二句";

const failure = (reply: { readonly ok: boolean }) => {
  if (reply.ok) throw new Error(`应该失败：${JSON.stringify(reply)}`);
  return reply as Extract<TranscriptReply, { ok: false }>;
};

/** 缓存驱动的故障开关：改不了、删不掉，写之前可以先卡住。 */
interface Faults {
  failPut: boolean;
  failRemove: boolean;
  hold: Deferred | null;
  held: number;
}

function faulty(faults: Faults) {
  return (inner: ObjectStoreDriver<Row>): ObjectStoreDriver<Row> => ({
    ...inner,
    async write(change = {}) {
      const failPut = faults.failPut && (change.put?.length ?? 0) > 0;
      const failRemove = faults.failRemove && (change.remove?.length ?? 0) > 0;
      if (faults.hold) {
        faults.held += 1;
        await faults.hold.promise;
      }
      if (failPut || failRemove) throw new Error("缓存写不进去");
      return inner.write(change);
    },
  });
}

/** 已经存进 imports 仓库的一份：字幕铺到 lastEnd 秒。 */
function importedRecord(lastEnd: number, extra: Partial<ImportRecord> = {}): ImportRecord {
  const cues: Cue[] = [0, 1, 2].map((index) => ({ start: (lastEnd * index) / 3, duration: 2, text: `导入 ${index}` }));
  return { videoKey: KEY, fileName: "外挂.srt", format: "srt", cues, importedAt: 1, ...extra };
}

// ============================================================
// 导入和读取
// ============================================================

test("导入的字幕进了缓存以后再读：官方总结过了重问时间或还是占位，也不向平台问", async () => {
  for (const official of [
    { status: "queued", summary: "", outline: [], hasCaptions: false, fetchedAt: 1 },
    { status: "pending", summary: "", outline: [], hasCaptions: false, fetchedAt: 1 },
  ] as const) {
    const h = harness({ seed: [cachedRow(undefined, { official })] });
    assert.equal((await h.service.importFile(REF, FILE)).ok, true);
    assert.equal(texts(await h.service.get(REF, { mode: "full" })), IMPORTED_TEXTS);
    const again = view(await h.service.get(REF, { mode: "full" }));
    assert.equal(again.fromCache, true, official.status);
    assert.equal(again.official?.status, official.status, "官方总结原样交回");
    assert.equal((await h.service.light(REF)).ok, true);
    assert.deepEqual(h.site.calls, [], official.status);
  }
});

test("先交了字幕、官方总结还在路上时导入了字幕文件：回来的官方总结照样填进缓存，之后用导入的字幕时看得到", async () => {
  const held = deferred();
  const h = harness({ site: { officialSummary: async () => (await held.promise, { ok: true, value: { status: "ok", summary: "迟到的官方摘要", outline: [], cues: [] } }) } });
  const first = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.equal(view(await first).official?.status, "pending");

  assert.equal((await h.service.importFile(REF, FILE)).ok, true);
  assert.equal((await h.rows())[0]?.transcript, undefined, "字幕作废了，占位留着");
  held.resolve();
  assert.ok(await until(async () => (await h.rows())[0]?.official?.status === "ok"), "回来的官方总结填进了字幕被作废的那条");

  const imported = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(texts({ ok: true, value: imported }), IMPORTED_TEXTS);
  assert.equal(imported.official?.summary, "迟到的官方摘要");
  assert.equal(h.site.count("readOfficialSummary"), 1);
});

test("用导入的字幕组装时官方总结还是占位、写缓存前回填已经落地：写进去的是回来的官方总结，不拿占位盖掉", async () => {
  const held = deferred();
  const gate = deferred();
  let gateNext = false;
  const h = harness({
    site: { officialSummary: async () => (await held.promise, { ok: true, value: { status: "ok", summary: "迟到的官方摘要", outline: [], cues: [] } }) },
    wrapCache: (inner) => ({
      ...inner,
      async load(key) {
        const loaded = await inner.load(key);
        if (gateNext) {
          gateNext = false;
          await gate.promise;
        }
        return loaded;
      },
    }),
  });
  const first = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.equal(view(await first).official?.status, "pending");
  assert.equal((await h.service.importFile(REF, FILE)).ok, true);

  // 用导入的字幕组装时读到的还是占位；卡在这里，让回填先落地。
  gateNext = true;
  const imported = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => !gateNext), "组装前读过了缓存");
  held.resolve();
  assert.ok(await until(async () => (await h.rows())[0]?.official?.status === "ok"), "回填已经写进缓存");
  gate.resolve();
  assert.equal(texts(await imported), IMPORTED_TEXTS);

  assert.equal((await h.rows())[0]?.official?.summary, "迟到的官方摘要");
  assert.equal(view(await h.service.get(REF, { mode: "cache-only" })).official?.summary, "迟到的官方摘要");
});

test("命中缓存后在后台重问官方总结、问的工夫导入了字幕文件：问到的照样写回，之后用导入的字幕时看得到", async () => {
  const held = deferred();
  const queued = { status: "queued", summary: "", outline: [], hasCaptions: false, fetchedAt: 1 } as const;
  const h = harness({
    seed: [cachedRow(undefined, { official: queued })],
    site: { officialSummary: async () => (await held.promise, { ok: true, value: { status: "ok", summary: "重问到的官方摘要", outline: [], cues: [] } }) },
  });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).official?.status, "queued", "先交缓存里的，后台在重问");
  assert.equal(h.site.count("readOfficialSummary"), 1);

  assert.equal((await h.service.importFile(REF, FILE)).ok, true);
  held.resolve();
  assert.ok(await until(async () => (await h.rows())[0]?.official?.status === "ok"), "问到的写回了字幕被作废的那条");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).official?.summary, "重问到的官方摘要");
  assert.equal(h.site.count("readOfficialSummary"), 1);
});

test("导入 SRT：存进 imports 仓库，回来的字幕标明来自导入的文件，不向 B 站取字幕", async () => {
  const h = harness();
  assert.deepEqual(await h.service.importFile(REF, FILE), { ok: true, value: { fileName: "课程.srt", entries: 2 } });

  const reply = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(reply.transcript.ref.kind, "imported");
  assert.equal(reply.transcript.label, IMPORTED_SUBTITLE_LABEL);
  assert.equal(reply.transcript.fileName, "课程.srt");
  assert.equal(texts({ ok: true, value: reply }), IMPORTED_TEXTS);
  assert.ok(reply.transcript.segments.length > 0, "照常分段，问答和概览用得上");

  const stored = await h.importsDriver.get(KEY);
  assert.equal(stored?.fileName, "课程.srt");
  assert.equal(stored?.cues.length, 2);
  assert.equal(h.site.calls.length, 0, "一个平台请求都没发");
});

test("导入之后强制刷新、清除缓存后再读：照样用导入的那份", async () => {
  const h = harness({ seed: [cachedRow()] });
  await h.service.importFile(REF, FILE);

  const refreshed = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(refreshed.transcript.ref.kind, "imported");

  h.service.forget("cache");
  await h.guard.clear("cache", () => h.driver.clear());
  const afterClear = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(afterClear.transcript.ref.kind, "imported", "清除缓存不动导入的字幕");
  assert.equal(texts({ ok: true, value: afterClear }), IMPORTED_TEXTS);
  assert.equal(h.site.calls.length, 0);
});

test("导入时缓存里已有 B 站字幕：先删掉那份，之后谁来读都是导入的", async () => {
  const h = harness({ seed: [cachedRow()] });
  await h.service.importFile(REF, FILE);
  assert.equal((await h.rows())[0]?.transcript, undefined, "缓存里的平台字幕作废了");

  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
  assert.equal(texts({ ok: true, value: result }), IMPORTED_TEXTS);
  const cacheOnly = view(await h.service.get(REF, { mode: "cache-only" }));
  assert.equal(cacheOnly.transcript.ref.kind, "imported", "组装好的那份进了缓存，只读缓存的也是它");
});

test("导入中文字幕按中文记语种（译成英文），英文字幕按英文记（译成中文）", async () => {
  const h = harness({ seed: [cachedRow()] });
  await h.service.importFile(REF, FILE);
  const chinese = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(chinese.transcript.ref.lang, "zh-CN");
  assert.equal(chinese.transcript.label, IMPORTED_SUBTITLE_LABEL, "出处照样标明");
  assert.equal(isChineseSubtitle(chinese.transcript.ref.lang), true);

  const english = SRT.replace("导入的第一句", "The first line").replace("导入的第二句", "And the second one");
  await h.service.importFile(REF, { name: "lecture.srt", text: english });
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.lang, "en");
  assert.equal(isChineseSubtitle(result.transcript.ref.lang), false);
});

test("导入和移除只作废字幕：官方总结、UP 主分段、视频信息留着", async () => {
  const chapters = [{ title: "开场", start: 0, end: 10 }];
  const official = { status: "ok", summary: "缓存里的官方摘要", outline: [], hasCaptions: false, fetchedAt: 1, fingerprint: "00112233aabbccdd" } as const;
  const seeded = cachedRow(undefined, { chapters, official });
  const h = harness({ seed: [seeded] });

  await h.service.importFile(REF, FILE);
  const [forgotten] = await h.rows();
  assert.equal(forgotten?.transcript, undefined);
  assert.deepEqual(forgotten?.tracks, [], "列出的字幕轨跟着字幕走");
  assert.deepEqual(forgotten?.info, seeded.info);
  assert.deepEqual(forgotten?.chapters, chapters);
  assert.deepEqual(forgotten?.official, official, "官方总结不跟字幕走");

  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
  assert.deepEqual(result.chapters, chapters);
  assert.equal(result.info.title, seeded.info.title);
  assert.equal(result.official?.summary, "缓存里的官方摘要", "组装好的结果带着官方总结");
  assert.equal(h.site.calls.length, 0);

  assert.deepEqual(await h.service.removeImport(REF), { ok: true, value: {} });
  const [removed] = await h.rows();
  assert.equal(removed?.transcript, undefined);
  assert.deepEqual(removed?.chapters, chapters);
  assert.deepEqual(removed?.info, seeded.info);
  assert.deepEqual(removed?.official, official);
});

test("有导入的字幕时不向 B 站要字幕列表；只读缓存的读取不拿它组装", async () => {
  const info = sampleInfo(REF, { title: "导入时记下的标题", durationSec: 600 });
  const h = harness({ imports: [importedRecord(590, { info })] });

  assert.equal(failure(await h.service.get(REF, { mode: "cache-only" })).code, "NOT_CACHED");
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
  assert.equal(result.info.title, "导入时记下的标题");
  assert.equal(h.site.calls.length, 0, "一个平台请求都没发");
  assert.equal((await h.rows()).length, 1, "对得上就进缓存");
});

test("缓存里已有对得上的 B 站字幕，导入的文件和视频时长对不上：照样用导入的那份，带上提示", async () => {
  const h = harness();
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "human");

  await h.importsDriver.write({ put: [importedRecord(5000)] });
  const result = view(await h.service.get(REF, { mode: "full", fresh: true }));
  assert.equal(result.transcript.ref.kind, "imported");
  assert.equal(result.subtitleMismatch, true, "对不上要提示");
  assert.equal(result.refreshMismatched, undefined, "不退回缓存里原来那份");
  assert.equal(texts({ ok: true, value: result }), "导入 0\n导入 1\n导入 2");
});

test("没登录、被限流时导入和读取照常：导入的字幕排在读视频信息之前，平台请求为零", async () => {
  for (const code of ["NEED_LOGIN", "RATE_LIMITED"] as const) {
    const h = harness({ site: { videoInfo: () => failed(code) } });
    assert.equal((await h.service.importFile(REF, FILE)).ok, true, code);
    const reply = view(await h.service.get(REF, { mode: "full", fresh: true }));
    assert.equal(reply.transcript.ref.kind, "imported", code);
    assert.equal(h.site.calls.length, 0, code);
    assert.equal(h.ctxs.length, 0, `${code}：连读取环境都没建`);
  }
});

test("点名平台的某条字幕轨时不拿导入的那份顶替", async () => {
  const h = harness({ seed: [cachedRow()] });
  await h.service.importFile(REF, FILE);
  await h.service.get(REF, { mode: "full" });

  const named = view(await h.service.get(REF, { mode: "full", lang: "zh-CN" }));
  assert.equal(named.transcript.ref.kind, "human");
  assert.equal(h.site.count("readCaptions"), 1);
});

test("导入字幕以后点名语言读了平台字幕：只交给这次调用，之后没点名语言的读取照样用导入的，不用刷新", async () => {
  const h = harness({ seed: [cachedRow()] });
  await h.service.importFile(REF, FILE);

  const named = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(named.transcript.ref.kind, "human");
  assert.equal(named.transcript.ref.lang, "en-US");
  const requests = h.site.calls.length;

  const plain = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(plain.transcript.ref.kind, "imported");
  assert.equal(texts({ ok: true, value: plain }), IMPORTED_TEXTS);
  assert.equal(h.site.calls.length, requests, "用导入的那份，不向平台发请求");
  assert.equal((await h.rows())[0]?.transcript?.ref.kind, "imported", "缓存里是导入的那份，不是点名读到的平台字幕");
  assert.equal(view(await h.service.get(REF, { mode: "cache-only" })).transcript.ref.kind, "imported");

  const again = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(again.transcript.ref.lang, "en-US", "再点名还能读到平台那条轨");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "imported");
});

test("导入字幕以后点名语言读到的平台字幕和视频时长对不上：也不记进内存，之后没点名语言的读取用导入的", async () => {
  const late: Cue[] = [0, 1, 2, 3, 4].map((index) => ({ start: index * 1000, duration: 2, text: `平台 ${index}` }));
  const h = harness({
    seed: [cachedRow(undefined, { info: sampleInfo(REF, { durationSec: 600 }) })],
    site: {
      videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref, { durationSec: 600 }) }),
      captions: (_info, track) => ({ ok: true, value: track.lang === "en-US" ? late : [{ start: 1, duration: 2, text: "平台中文" }] }),
    },
  });
  await h.service.importFile(REF, FILE);

  assert.equal(view(await h.service.get(REF, { mode: "full", lang: "en-US" })).subtitleMismatch, true);
  const plain = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(plain.transcript.ref.kind, "imported");
  assert.equal(texts({ ok: true, value: plain }), IMPORTED_TEXTS);
});

test("本机不知道视频信息时：标题用标签页的，没有就用文件名，这份不进缓存", async () => {
  const h = harness({ tabTitles: { 7: "标签页的标题" } });
  await h.service.importFile(REF, FILE);

  const withTab = view(await h.service.get(REF, { mode: "full", tabId: 7 }));
  assert.equal(withTab.info.title, "标签页的标题");
  assert.equal(withTab.transcript.ref.kind, "imported");
  const plain = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(plain.info.title, "课程.srt");
  assert.deepEqual(await h.rows(), [], "顶上的标题不能当成读到的视频信息存下");
  assert.equal(h.site.calls.length, 0);
});

test("导入和移除让这个视频的字幕代数加一，别的视频不动", async () => {
  const h = harness();
  const other = { ...REF, segment: 2 };
  assert.equal(h.service.generation(REF), 0);
  await h.service.importFile(REF, FILE);
  assert.equal(h.service.generation(REF), 1);
  await h.service.removeImport(REF);
  assert.equal(h.service.generation(REF), 2);
  assert.equal(h.service.generation(other), 0);
});

// ============================================================
// 文件读不了
// ============================================================

test("不是 SRT/VTT、或者读不出字幕：不存，说明原因", async () => {
  const h = harness();
  const wrongType = failure(await h.service.importFile(REF, { name: "课程.ass", text: SRT }));
  assert.equal(wrongType.code, "UNSUPPORTED_FILE");
  const unreadable = failure(await h.service.importFile(REF, { name: "课程.srt", text: "这不是字幕" }));
  assert.equal(unreadable.code, "UNSUPPORTED_FILE");
  assert.match(describe(unreadable.code, unreadable.detail), /SRT 和 VTT/);
  const badVideo = failure(await h.service.importFile({ platform: "bilibili", videoId: "not-a-video" }, FILE));
  assert.equal(badVideo.code, "INVALID_REQUEST");
  assert.deepEqual(await h.importsDriver.getAll(), []);
  assert.equal(h.site.calls.length, 0);
});

// ============================================================
// 作废失败时撤回
// ============================================================

test("缓存写不进去时导入算失败：存着的文件撤回，界面和缓存仍是原来的 B 站字幕", async () => {
  const faults: Faults = { failPut: true, failRemove: true, hold: null, held: 0 };
  const h = harness({ seed: [cachedRow()], wrapDriver: faulty(faults) });
  const imported = failure(await h.service.importFile(REF, FILE));
  assert.equal(imported.code, "CACHE_WRITE_FAILED");
  assert.match(describe(imported.code), /没有改/);
  assert.deepEqual(await h.importsDriver.getAll(), [], "文件没留下");
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "human");
  assert.equal(result.fromCache, true);
});

test("换一个文件导入时缓存写不进去：恢复成之前导入的那个文件", async () => {
  const faults: Faults = { failPut: false, failRemove: false, hold: null, held: 0 };
  const h = harness({ seed: [cachedRow()], wrapDriver: faulty(faults) });
  await h.service.importFile(REF, FILE);
  await h.service.get(REF, { mode: "full" });
  Object.assign(faults, { failPut: true, failRemove: true });

  const replaced = failure(await h.service.importFile(REF, { ...FILE, name: "另一个.srt" }));
  assert.equal(replaced.code, "CACHE_WRITE_FAILED");
  assert.equal((await h.importsDriver.get(KEY))?.fileName, "课程.srt");
});

test("移除时缓存写不进去：移除算失败，导入的文件留着，读到的仍是导入的字幕", async () => {
  const faults: Faults = { failPut: false, failRemove: false, hold: null, held: 0 };
  const h = harness({ seed: [cachedRow()], wrapDriver: faulty(faults) });
  await h.service.importFile(REF, FILE);
  await h.service.get(REF, { mode: "full" });
  Object.assign(faults, { failPut: true, failRemove: true });

  const removed = failure(await h.service.removeImport(REF));
  assert.equal(removed.code, "CACHE_WRITE_FAILED");
  assert.equal((await h.importsDriver.get(KEY))?.fileName, "课程.srt", "文件恢复了");
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
});

test("同一个视频两次导入都因缓存写不进去失败：排着队各自撤回，最后什么都没留下", async () => {
  const faults: Faults = { failPut: true, failRemove: true, hold: deferred(), held: 0 };
  const h = harness({ seed: [cachedRow()], wrapDriver: faulty(faults) });
  const first = h.service.importFile(REF, { ...FILE, name: "甲.srt" });
  assert.ok(await until(() => faults.held > 0), "第一次导入卡在作废写入");
  const second = h.service.importFile(REF, { ...FILE, name: "乙.srt" });
  const hold = faults.hold;
  faults.hold = null;
  hold?.resolve();

  assert.equal(failure(await first).code, "CACHE_WRITE_FAILED");
  assert.equal(failure(await second).code, "CACHE_WRITE_FAILED");
  assert.deepEqual(await h.importsDriver.getAll(), [], "第二次没把第一次的文件当成原样写回去");
});

test("缓存条目改不了但删得掉：整条删掉，导入照常成功", async () => {
  const faults: Faults = { failPut: true, failRemove: false, hold: null, held: 0 };
  const h = harness({ seed: [cachedRow()], wrapDriver: faulty(faults) });
  const imported = await h.service.importFile(REF, FILE);
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.deepEqual(await h.rows(), [], "旧条目整条删了");

  faults.failPut = false;
  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
});

test("移除导入的字幕：存着的文件和缓存里那份都删掉，再读就不是导入的了", async () => {
  const h = harness({ seed: [cachedRow()] });
  await h.service.importFile(REF, FILE);
  await h.service.get(REF, { mode: "full" });

  assert.deepEqual(await h.service.removeImport(REF), { ok: true, value: {} });
  assert.deepEqual(await h.importsDriver.getAll(), []);
  assert.equal(failure(await h.service.get(REF, { mode: "cache-only" })).code, "NOT_CACHED", "缓存里用导入文件组装的那份也删了");
  const again = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(again.transcript.ref.kind, "human");
});

// ============================================================
// 导入和在途读取
// ============================================================

test("取 B 站字幕的读取还没回来就导入了字幕文件：回来的那份交给调用方，但不写进缓存", async () => {
  const held = deferred();
  const h = harness({ site: { captions: (_info, track) => held.promise.then(() => ({ ok: true as const, value: [{ start: 0, duration: 2, text: `平台 ${track.lang}` }] })) } });
  const reading = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") > 0), "已经在下载平台字幕");

  assert.equal((await h.service.importFile(REF, FILE)).ok, true);
  held.resolve();
  const stale = view(await reading);
  assert.equal(stale.transcript.ref.kind, "human", "发起的调用方照样拿到自己那份");
  assert.equal((await h.rows()).some((row) => row.transcript?.ref.kind === "human"), false, "旧读取没写进缓存");

  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
});

test("字幕对不上的旧读取同样不记进内存：导入之后再读拿到的是导入的", async () => {
  const held = deferred();
  const late: Cue[] = [0, 1, 2, 3, 4].map((index) => ({ start: index * 1000, duration: 2, text: `平台 ${index}` }));
  const h = harness({
    site: {
      videoInfo: (ref) => ({ ok: true, value: sampleInfo(ref, { durationSec: 600 }) }),
      captions: () => held.promise.then(() => ({ ok: true as const, value: late })),
    },
  });
  const reading = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.site.count("readCaptions") > 0));

  await h.service.importFile(REF, FILE);
  held.resolve();
  assert.equal(view(await reading).subtitleMismatch, true);

  const result = view(await h.service.get(REF, { mode: "full" }));
  assert.equal(result.transcript.ref.kind, "imported");
  assert.equal(texts({ ok: true, value: result }), IMPORTED_TEXTS);
});

test("导入或移除还没做完（比如作废失败、正在撤回）时来的读取：等做完再读，拿不到要撤回的文件", async () => {
  const faults: Faults = { failPut: true, failRemove: true, hold: deferred(), held: 0 };
  const h = harness({ seed: [cachedRow()], wrapDriver: faulty(faults) });
  const importing = h.service.importFile(REF, FILE);
  assert.ok(await until(() => faults.held > 0), "文件已经写进去，作废卡住");
  assert.equal((await h.importsDriver.get(KEY))?.fileName, "课程.srt");

  let settled = false;
  const reading = h.service.get(REF, { mode: "full", fresh: true });
  void reading.then(() => (settled = true));
  assert.equal(await until(() => settled, 50), false, "撤回之前读取等着");
  assert.equal(h.site.calls.length, 0);

  const hold = faults.hold;
  faults.hold = null;
  hold?.resolve();
  assert.equal(failure(await importing).code, "CACHE_WRITE_FAILED");
  const result = view(await reading);
  assert.equal(result.transcript.ref.kind, "human", "读到的是撤回之后的样子");
  assert.equal((await h.rows()).some((row) => row.transcript?.ref.kind === "imported"), false);
});
