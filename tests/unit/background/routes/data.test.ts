// 资料一节：导出、导入备份的两条长连接和清除的一条消息。导出的备份能原样导回来，导两次不重复；清除缓存留着笔记，
// 清除全部连设置一起清掉并广播；导出和清除确认启用之前也能用，导入要先确认；只有设置页能连、能发。清除连取字幕服务内存里记着的一起忘掉。
import assert from "node:assert/strict";
import { translationId, type TranslationRecord } from "../../../../src/core/notes/records.ts";
import { createObjectStoreDriver } from "../../../../src/platform/idb.ts";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { createDataService } from "../../../../src/background/services/data.ts";
import { dataPorts } from "../../../../src/background/routes/data.ts";
import { ROUTE_MATRIX, rowOf } from "../route-matrix.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import { readFileSync } from "node:fs";
import { readBackup } from "../../../../src/core/backup/format.ts";
import { PART_BUDGET } from "../../../../src/core/backup/parts.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { NoteListView } from "../../../../src/shared/messages/notes.ts";
import { SETTINGS_STORAGE_KEY, TRIAGE_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { createFakeChrome, senders } from "../../../helpers/chrome.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";
import { exportOver, importOver, pageApiOver } from "../../../helpers/backup-port.ts";
import { until } from "../../../helpers/wait-until.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });
const NOTE = { id: "note_sample", kind: "note", origin: "user", video: VIDEO, snapshot: { title: "样例", author: "作者" }, atSec: 5, text: "一条", createdAt: 1, updatedAt: 2 };

async function noteCount(bg: ReturnType<typeof studyBackground>): Promise<number> {
  const listed = await bg.send<NoteListView>("notes.list", {});
  assert.ok(listed.ok, JSON.stringify(listed));
  return listed.value.notes.length;
}

test("导出的备份清除全部数据后能导回来，再导一次不重复", async () => {
  const bg = studyBackground({ withoutAi: true });
  const saved = await bg.send("notes.save", { video: VIDEO, atSec: 12, text: "自己写的一条笔记" });
  assert.ok(saved.ok, JSON.stringify(saved));

  const exported = await exportOver(bg.fake, bg.app);
  assert.ok(exported.ok, JSON.stringify(exported));
  assert.equal(exported.value.kind, "jianmu-backup");
  assert.equal(exported.value.notes.length, 1);
  const payload = JSON.parse(JSON.stringify(exported.value));

  assert.deepEqual(await bg.send("data.clear", { scope: "all" }, senders.options()), { ok: true, value: {} });
  assert.ok(bg.fake.calls.broadcasts.some((message) => JSON.stringify(message) === JSON.stringify({ type: "data.cleared", scope: "all" })));
  assert.equal((await bg.fake.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY], undefined, "设置连同启用确认一起清掉");
  // 清掉以后要重新确认启用才能导入。
  assert.deepEqual(await importOver(bg.fake, bg.app, payload), { ok: false, code: "NOT_ENABLED" });
  assert.ok((await bg.send("activation.confirm", {}, senders.options())).ok);
  assert.equal(await noteCount(bg), 0);

  const first = await importOver(bg.fake, bg.app, payload);
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(first.value.counts.notes, { added: 1, updated: 0, skipped: 0 });
  assert.equal(await noteCount(bg), 1);
  const again = await importOver(bg.fake, bg.app, payload);
  assert.ok(again.ok);
  assert.deepEqual(again.value.counts.notes, { added: 0, updated: 0, skipped: 0 });
  assert.equal(await noteCount(bg), 1);
  assert.deepEqual(again.value.counts.translations, { added: 0, updated: 0, skipped: 0 });
});

test("译文和整理后的字幕也进备份：清除全部数据后导回来，再导一次不重复，本机后来补的段不被盖掉", async () => {
  const bg = studyBackground({ withoutAi: true });
  const driver = createObjectStoreDriver<TranslationRecord>({ storeName: "translations", indexedDB: bg.fake.indexedDB });
  const transcript = { video: VIDEO, kind: "auto" as const, lang: "zh-CN", fingerprint: "fp-sample" };
  const record = (target: TranslationRecord["target"], segments: Record<string, string>): TranslationRecord => ({
    id: translationId(transcript, target),
    video: VIDEO,
    transcript,
    target,
    segments,
    derived: { basis: { source: "transcript", transcript }, gen: { feature: target === "tidy" ? "tidy" : "rewrite", promptVersion: "v1", model: "m", effort: "off" } },
    updatedAt: 100,
  });
  await driver.write({ put: [record("tidy", { a1a1a1a1a1a1a1a1: "大家好，欢迎回来。" }), record("en", { a1a1a1a1a1a1a1a1: "Hello." })] });

  const exported = await exportOver(bg.fake, bg.app);
  assert.ok(exported.ok, JSON.stringify(exported));
  assert.equal(exported.value.version, 2);
  assert.deepEqual(exported.value.translations.map((item) => item.target).sort(), ["en", "tidy"]);
  const payload = JSON.parse(JSON.stringify(exported.value));

  assert.deepEqual(await bg.send("data.clear", { scope: "all" }, senders.options()), { ok: true, value: {} });
  assert.ok((await bg.send("activation.confirm", {}, senders.options())).ok);
  assert.deepEqual(await driver.getAll(), []);
  // 清掉以后本机又整理了一段：导入时只补备份里有、本机没有的段。
  await driver.write({ put: [record("tidy", { a1a1a1a1a1a1a1a1: "后来重新整理的。", b2b2b2b2b2b2b2b2: "新的一段。" })] });

  const first = await importOver(bg.fake, bg.app, payload);
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(first.value.counts.translations, { added: 1, updated: 0, skipped: 0 }, "英文整条加上；整理的那条段都在本机，不算更新");
  const tidy = (await driver.getAll()).find((item) => item.target === "tidy");
  assert.deepEqual(tidy?.segments, { a1a1a1a1a1a1a1a1: "后来重新整理的。", b2b2b2b2b2b2b2b2: "新的一段。" });
  const again = await importOver(bg.fake, bg.app, payload);
  assert.ok(again.ok);
  assert.deepEqual(again.value.counts.translations, { added: 0, updated: 0, skipped: 0 });
});

test("超过单条消息上限的备份分段传：导出拼回同一份，清除后导回来条数对得上，再导一次不重复", async () => {
  const bg = studyBackground({ withoutAi: true });
  const driver = createObjectStoreDriver<TranslationRecord>({ storeName: "translations", indexedDB: bg.fake.indexedDB });
  const transcript = { video: VIDEO, kind: "auto" as const, lang: "zh-CN", fingerprint: "fp-large" };
  // 一条译文本身就比一段大：六百段，每段一万多字。
  const line = "这一段字幕翻好以后放在这里，".repeat(1_150);
  const segments = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [index.toString(16).padStart(8, "a"), `${index} ${line}`]));
  const big: TranslationRecord = {
    id: translationId(transcript, "en"),
    video: VIDEO,
    transcript,
    target: "en",
    segments,
    derived: { basis: { source: "transcript", transcript }, gen: { feature: "rewrite", promptVersion: "v1", model: "m", effort: "off" } },
    updatedAt: 100,
  };
  assert.ok(JSON.stringify(big).length > PART_BUDGET, "要切成至少两段");
  await driver.write({ put: [big] });
  for (let index = 0; index < 30; index += 1) assert.ok((await bg.send("notes.save", { video: VIDEO, atSec: index, text: `笔记 ${index}` })).ok);

  const exported = await exportOver(bg.fake, bg.app);
  assert.ok(exported.ok, JSON.stringify(exported).slice(0, 200));
  assert.equal(exported.value.notes.length, 30);
  assert.deepEqual(exported.value.translations, [big], "切开的那条按原样拼回");
  const payload = JSON.parse(JSON.stringify(exported.value));

  assert.deepEqual(await bg.send("data.clear", { scope: "all" }, senders.options()), { ok: true, value: {} });
  assert.ok((await bg.send("activation.confirm", {}, senders.options())).ok);
  const first = await importOver(bg.fake, bg.app, payload);
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(first.value.counts.notes, { added: 30, updated: 0, skipped: 0 });
  assert.deepEqual(first.value.counts.translations, { added: 1, updated: 0, skipped: 0 }, "分几段补进来的仍算新增一条");
  assert.equal(await noteCount(bg), 30);
  const [restored, ...rest] = await driver.getAll();
  assert.deepEqual(rest, []);
  assert.deepEqual(restored?.segments, big.segments, "六百段一段不少");
  assert.deepEqual(Object.keys(restored?.segments ?? {}), Object.keys(big.segments), "段的顺序也一样");
  const again = await importOver(bg.fake, bg.app, payload);
  assert.ok(again.ok);
  assert.deepEqual(again.value.counts.translations, { added: 0, updated: 0, skipped: 0 });
  assert.deepEqual(again.value.counts.notes, { added: 0, updated: 0, skipped: 0 });
});

test("导入途中清除全部数据：后面几段不再写，页面收到「已清除」", async () => {
  const bg = studyBackground({ withoutAi: true });
  pageApiOver(bg.fake, bg.app);
  const port = bg.fake.connect("backup.import", senders.options());
  port.send({ type: "part", seq: 0, kind: "notes", records: [NOTE] });
  assert.ok(await until(() => port.posted.length === 1));
  assert.deepEqual(port.posted[0], { type: "merged", seq: 0, added: [NOTE.id], updated: [], skipped: 0 });
  assert.deepEqual(await bg.send("data.clear", { scope: "all" }, senders.options()), { ok: true, value: {} });
  port.send({ type: "part", seq: 1, kind: "notes", records: [{ ...NOTE, id: "note_later" }] });
  assert.ok(await until(() => port.disconnected));
  assert.deepEqual(port.posted.at(-1), { type: "port.error", code: "LOCAL_DATA_CLEARED" });
  assert.ok((await bg.send("activation.confirm", {}, senders.options())).ok);
  assert.equal(await noteCount(bg), 0);
});

test("两份旧格式样例经端口导入：后台核对时不再多跳过，条数和整份一次读出来的一样；再导一次不重复", async () => {
  for (const name of ["digest-for-bilibili.json", "existing-version.json"]) {
    const bg = studyBackground({ withoutAi: true });
    const payload = JSON.parse(readFileSync(new URL(`../../../fixtures/legacy-backups/${name}`, import.meta.url), "utf8"));
    const read = readBackup(payload);
    assert.ok(read.ok, name);
    const first = await importOver(bg.fake, bg.app, payload);
    assert.ok(first.ok, `${name}：${JSON.stringify(first)}`);
    for (const kind of ["notes", "overviews", "qa", "translations"] as const) {
      assert.deepEqual(first.value.counts[kind], { added: read.value.contents[kind].length, updated: 0, skipped: read.value.skipped[kind] }, `${name} ${kind}`);
    }
    const again = await importOver(bg.fake, bg.app, payload);
    assert.ok(again.ok);
    for (const kind of ["notes", "overviews", "qa", "translations"] as const) {
      assert.equal(again.value.counts[kind].added + again.value.counts[kind].updated, 0, `${name} ${kind} 再导一次`);
    }
  }
});

test("合并时存储写满：先告诉页面写满了再断开；已经写进去的那几段照样广播一次", async () => {
  const broadcasts: string[] = [];
  const quota = Object.assign(new Error("写不下了"), { name: "QuotaExceededError" });
  let calls = 0;
  const spec = dataPorts({
    data: {
      openExport: () => assert.fail(),
      clear: async () => assert.fail(),
      busy: () => false,
      openImport: () => ({
        async merge() {
          calls += 1;
          if (calls > 1) throw quota;
          return { ok: true, value: { added: ["note_a"], updated: [], skipped: 0 } };
        },
        close: () => void broadcasts.push("notes.changed"),
      }),
    },
    log: { error: () => assert.fail("写满不算后台出错") },
  })["backup.import"];
  const posted: unknown[] = [];
  let closed = false;
  const session = spec.onConnect({ id: "port-1", post: (message) => void posted.push(message), close: () => void (closed = true) }, senders.options() as never);
  await session.onMessage({ type: "part", seq: 0, kind: "notes", records: [] });
  await session.onMessage({ type: "part", seq: 1, kind: "notes", records: [] });
  assert.deepEqual(posted, [
    { type: "merged", seq: 0, added: ["note_a"], updated: [], skipped: 0 },
    { type: "port.error", code: "STORAGE_FULL" },
  ]);
  assert.equal(closed, true);
  session.onDisconnect?.();
  assert.ok(await until(() => broadcasts.length === 1));
});

test("清除缓存只清能重新取回的，笔记和设置都留着", async () => {
  const bg = studyBackground({ withoutAi: true });
  assert.ok((await bg.send("notes.save", { video: VIDEO, atSec: 3, text: "留着" })).ok);
  await bg.fake.local.set({ [TRIAGE_STORAGE_KEY]: { items: [] } });
  assert.deepEqual(await bg.send("data.clear", { scope: "cache" }, senders.options()), { ok: true, value: {} });
  assert.equal((await bg.fake.local.get(TRIAGE_STORAGE_KEY))[TRIAGE_STORAGE_KEY], undefined);
  assert.notEqual((await bg.fake.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY], undefined);
  assert.equal(await noteCount(bg), 1);
});

test("认不出的文件整份拒绝，形状不对的消息不处理", async () => {
  const bg = studyBackground({ withoutAi: true });
  assert.deepEqual(await importOver(bg.fake, bg.app, { hello: 1 }), { ok: false, code: "BACKUP_UNRECOGNIZED" });
  pageApiOver(bg.fake, bg.app);
  const port = bg.fake.connect("backup.import", senders.options());
  for (const message of [{}, { type: "part", seq: 0, kind: "prompts", records: [] }, { type: "part", seq: 0, kind: "notes", records: {} }, { type: "part", seq: 0, kind: "notes", records: [], extra: 1 }]) {
    port.send(message);
  }
  assert.ok(await until(() => port.posted.length === 4));
  assert.deepEqual(port.posted, Array(4).fill({ type: "port.error", code: "INVALID_REQUEST" }));
  for (const req of [{}, { scope: "everything" }, { scope: "all", extra: 1 }]) {
    assert.deepEqual(await bg.send("data.clear", req, senders.options()), { ok: false, code: "INVALID_REQUEST" });
  }
});

test("后台再核对一遍：页面发来的坏记录逐条跳过并计数", async () => {
  const bg = studyBackground({ withoutAi: true });
  pageApiOver(bg.fake, bg.app);
  const port = bg.fake.connect("backup.import", senders.options());
  port.send({ type: "part", seq: 7, kind: "notes", records: [{ id: 1 }, "坏的"] });
  assert.ok(await until(() => port.posted.length === 1));
  assert.deepEqual(port.posted, [{ type: "merged", seq: 7, added: [], updated: [], skipped: 2 }]);
});

test("确认启用之前：设置页能导出和清除，不查标签页、不发网络请求", async () => {
  const fake = createFakeChrome();
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const exported = await exportOver(fake, app);
  assert.ok(exported.ok, JSON.stringify(exported));
  assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope: "cache" } }, senders.options()), { ok: true, value: {} });
  assert.deepEqual(fake.calls.tabQueries, []);
  assert.deepEqual(fake.calls.fetches, []);
});

test("备份的两个端口：发送方、页面和确认前放不放行，都等于允许矩阵里那一行", () => {
  const ports = dataPorts({ data: { openExport: () => assert.fail(), openImport: () => assert.fail(), clear: async () => assert.fail(), busy: () => false }, log: { error: () => assert.fail() } });
  for (const [name, spec] of Object.entries(ports)) {
    const expected = ROUTE_MATRIX.find((row) => row.name === name && row.port);
    assert.ok(expected, `${name} 不在允许矩阵里`);
    assert.deepEqual({ ...rowOf(name, spec), port: true }, expected, name);
  }
});

test("侧边栏、粗筛页、卡片和内容脚本都连不上、发不了", async () => {
  const bg = studyBackground({ withoutAi: true });
  for (const sender of [senders.panel(), senders.triage(), senders.card(), senders.content()]) {
    assert.deepEqual(await exportOver(bg.fake, bg.app, sender), { ok: false, code: "FORBIDDEN" });
    assert.deepEqual(await importOver(bg.fake, bg.app, { kind: "jianmu-backup", version: 2, notes: [NOTE] }, sender), { ok: false, code: "FORBIDDEN" });
    assert.deepEqual(await bg.send("data.clear", { scope: "all" }, sender), { ok: false, code: "FORBIDDEN" });
  }
});

test("两种清除都忘掉取字幕服务内存里记着的，而且在清除闸门里做", async () => {
  const forgotten: string[] = [];
  let clearing = false;
  const guard = createClearGuard();
  const data = createDataService({
    notes: { all: async () => [], update: async () => null },
    overviews: { all: async () => [], update: async () => null },
    qa: { all: async () => [], commit: async () => true },
    translations: { all: async () => [], update: async () => null },
    guard: {
      ...guard,
      clear: (scope, run) =>
        guard.clear(scope, async () => {
          clearing = true;
          try {
            return await run();
          } finally {
            clearing = false;
          }
        }),
    },
    tasks: { cancelAll: () => {} },
    settings: { clearAll: async () => {} },
    storage: createFakeChrome().deps({ warn() {}, error() {} }).storage,
    forgetMemory: (scope) => void forgotten.push(`${scope}:${clearing}`),
    clearStore: async () => {},
    broadcast: () => {},
    now: () => 0,
  });
  await data.clear("cache");
  await data.clear("all");
  assert.deepEqual(forgotten, ["cache:true", "all:true"]);
});
