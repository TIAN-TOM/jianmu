// 资料一节的三条路由：导出的备份能原样导回来，导两次不重复；清除缓存留着笔记，清除全部连设置一起清掉并广播；
// 导出和清除确认启用之前也能用，导入要先确认；只有设置页能发。清除连取字幕服务内存里记着的一起忘掉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import { createDataService } from "../../../../src/background/services/data.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import type { Backup } from "../../../../src/core/backup/format.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { BackupImportReply } from "../../../../src/shared/messages/data.ts";
import type { NoteListView } from "../../../../src/shared/messages/notes.ts";
import { SETTINGS_STORAGE_KEY, TRIAGE_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { createFakeChrome, senders } from "../../../helpers/chrome.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });

async function noteCount(bg: ReturnType<typeof studyBackground>): Promise<number> {
  const listed = await bg.send<NoteListView>("notes.list", {});
  assert.ok(listed.ok, JSON.stringify(listed));
  return listed.value.notes.length;
}

test("导出的备份清除全部数据后能导回来，再导一次不重复", async () => {
  const bg = studyBackground({ withoutAi: true });
  const saved = await bg.send("notes.save", { video: VIDEO, atSec: 12, text: "自己写的一条笔记" });
  assert.ok(saved.ok, JSON.stringify(saved));

  const exported = await bg.send<Backup>("backup.export", {}, senders.options());
  assert.ok(exported.ok, JSON.stringify(exported));
  assert.equal(exported.value.kind, "jianmu-backup");
  assert.equal(exported.value.notes.length, 1);
  const payload = JSON.parse(JSON.stringify(exported.value));

  assert.deepEqual(await bg.send("data.clear", { scope: "all" }, senders.options()), { ok: true, value: {} });
  assert.ok(bg.fake.calls.broadcasts.some((message) => JSON.stringify(message) === JSON.stringify({ type: "data.cleared", scope: "all" })));
  assert.equal((await bg.fake.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY], undefined, "设置连同启用确认一起清掉");
  // 清掉以后要重新确认启用才能导入。
  assert.deepEqual(await bg.send("backup.import", { payload }, senders.options()), { ok: false, code: "NOT_ENABLED" });
  assert.ok((await bg.send("activation.confirm", {}, senders.options())).ok);
  assert.equal(await noteCount(bg), 0);

  const first = await bg.send<BackupImportReply>("backup.import", { payload }, senders.options());
  assert.ok(first.ok, JSON.stringify(first));
  assert.deepEqual(first.value.counts.notes, { added: 1, updated: 0, skipped: 0 });
  assert.equal(await noteCount(bg), 1);
  const again = await bg.send<BackupImportReply>("backup.import", { payload }, senders.options());
  assert.ok(again.ok);
  assert.deepEqual(again.value.counts.notes, { added: 0, updated: 0, skipped: 0 });
  assert.equal(await noteCount(bg), 1);
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

test("认不出的文件整份拒绝，请求形状不对的不处理", async () => {
  const bg = studyBackground({ withoutAi: true });
  assert.deepEqual(await bg.send("backup.import", { payload: { hello: 1 } }, senders.options()), { ok: false, code: "BACKUP_UNRECOGNIZED" });
  for (const req of [{}, { payload: {}, extra: 1 }]) {
    assert.deepEqual(await bg.send("backup.import", req, senders.options()), { ok: false, code: "INVALID_REQUEST" });
  }
  for (const req of [{}, { scope: "everything" }, { scope: "all", extra: 1 }]) {
    assert.deepEqual(await bg.send("data.clear", req, senders.options()), { ok: false, code: "INVALID_REQUEST" });
  }
});

test("确认启用之前：设置页能导出和清除，不查标签页、不发网络请求", async () => {
  const fake = createFakeChrome();
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const exported = await app.dispatch({ type: "backup.export", req: {} }, senders.options());
  assert.ok((exported as { ok: boolean }).ok, JSON.stringify(exported));
  assert.deepEqual(await app.dispatch({ type: "data.clear", req: { scope: "cache" } }, senders.options()), { ok: true, value: {} });
  assert.deepEqual(fake.calls.tabQueries, []);
  assert.deepEqual(fake.calls.fetches, []);
});

test("侧边栏、粗筛页、卡片和内容脚本都发不了", async () => {
  const bg = studyBackground({ withoutAi: true });
  for (const sender of [senders.panel(), senders.triage(), senders.card(), senders.content()]) {
    for (const [type, req] of [
      ["backup.export", {}],
      ["backup.import", { payload: {} }],
      ["data.clear", { scope: "all" }],
    ] as const) {
      assert.deepEqual(await bg.send(type, req, sender), { ok: false, code: "FORBIDDEN" }, type);
    }
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
