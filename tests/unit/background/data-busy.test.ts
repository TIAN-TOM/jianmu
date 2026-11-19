// 导出、导入备份和清除数据算作忙：文件换了要重新加载时等它们完全做完，成功失败都放开。
// 导入跨好几条消息，从连上到断开（在合并的那段做完）都算；清除从开始到删完设置都算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { dataPorts } from "../../../src/background/routes/data.ts";
import { createDataService, type DataServiceDeps } from "../../../src/background/services/data.ts";
import { BUSY_RECHECK_MS } from "../../../src/background/self-update.ts";
import { createClearGuard } from "../../../src/core/clear-guard.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import type { PortLike } from "../../../src/platform/messaging.ts";
import { createFakeChrome, senders } from "../../helpers/chrome.ts";
import { deferred } from "../../helpers/deferred.ts";
import { SAMPLE_ID } from "../../helpers/fake-site-service.ts";
import { studyBackground } from "../../helpers/study-background.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });
const note = (id: string) => ({ id, kind: "note", origin: "user", video: VIDEO, snapshot: { title: "样例", author: "作者" }, atSec: 5, text: id, createdAt: 1, updatedAt: 2 });

function service(overrides: Partial<DataServiceDeps> = {}) {
  return createDataService({
    notes: { all: async () => [], update: async () => null },
    overviews: { all: async () => [], update: async () => null },
    qa: { all: async () => [], commit: async () => true },
    translations: { all: async () => [], update: async () => null },
    guard: createClearGuard(),
    tasks: { cancelAll: () => {} },
    settings: { clearAll: async () => {} },
    storage: createFakeChrome().deps({ warn() {}, error() {} }).storage,
    forgetMemory: () => {},
    clearStore: async () => {},
    broadcast: () => {},
    now: () => 0,
    ...overrides,
  });
}

test("清除：从开始到删完都算忙，删完放开；删到一半出错也放开", async () => {
  const store = deferred();
  const data = service({ clearStore: () => store.promise });
  assert.equal(data.busy(), false);
  const clearing = data.clear("all");
  assert.equal(data.busy(), true, "停任务、等闸门之前就算忙");
  assert.ok(await stillFalse(() => !data.busy()), "仓库还没删完");
  store.resolve();
  await clearing;
  assert.equal(data.busy(), false);

  const broken = service({ settings: { clearAll: async () => Promise.reject(new Error("存储坏了")) } });
  await assert.rejects(broken.clear("all"), /存储坏了/);
  assert.equal(broken.busy(), false, "失败也放开");
});

test("导出、导入：会话开着就算忙，关上放开；关两次不多减", () => {
  const data = service();
  const exporting = data.openExport();
  const importing = data.openImport();
  assert.equal(data.busy(), true);
  exporting.close();
  exporting.close();
  assert.equal(data.busy(), true, "导入还开着");
  importing.close();
  importing.close();
  assert.equal(data.busy(), false);
});

test("导出端口：连上就算忙，发完不放，页面断开才放", async () => {
  const data = service();
  const spec = dataPorts({ data, log: { error: () => assert.fail() } })["backup.export"];
  const posted: { type: string }[] = [];
  const session = spec.onConnect({ id: "port-1", post: (message) => void posted.push(message as { type: string }), close: () => {} }, senders.options() as never);
  assert.equal(data.busy(), true);
  await session.onMessage({ type: "start" });
  assert.equal(posted.at(-1)?.type, "end");
  assert.equal(data.busy(), true, "页面还在收、还没下载");
  session.onDisconnect?.();
  assert.equal(data.busy(), false);
});

/** 一个能看文件换没换、能重新加载的后台，长连接接到它上面。 */
function reloadingBackground() {
  const bg = studyBackground({ withoutAi: true });
  let reloads = 0;
  const deps = bg.fake.deps({ warn() {}, error() {} });
  const app = createApp({ ...deps, runtime: { ...deps.runtime, reload: () => void (reloads += 1) }, readOwnFile: async () => "换过的构建" });
  bg.fake.chrome.runtime.onConnect.addListener(((port: PortLike) => app.connect(port)) as never);
  const nextPart = async (port: ReturnType<typeof bg.fake.connect>, seq: number, id: string) => {
    port.send({ type: "part", seq, kind: "notes", records: [note(id)] });
    assert.ok(await until(() => port.posted.length === seq + 1), JSON.stringify(port.posted));
  };
  return { ...bg, app, nextPart, reloads: () => reloads, timers: bg.fake.timers };
}

test("恢复备份跨好几段：中途发现文件换了不重载，段与段之间也不重载；页面断开以后才重载", async () => {
  const bg = reloadingBackground();
  const port = bg.fake.connect("backup.import", senders.options());
  await bg.nextPart(port, 0, "note_a");
  bg.app.onWake();
  assert.ok(await until(() => bg.timers.due(BUSY_RECHECK_MS) === 1), "忙着，隔一会儿再看");
  assert.equal(bg.reloads(), 0);

  await bg.nextPart(port, 1, "note_b");
  bg.timers.fire(BUSY_RECHECK_MS);
  assert.ok(await until(() => bg.timers.due(BUSY_RECHECK_MS) === 1), "两段之间还算忙");
  assert.equal(bg.reloads(), 0);

  port.close();
  bg.timers.fire(BUSY_RECHECK_MS);
  assert.ok(await until(() => bg.reloads() === 1), "导完断开以后重载");
});

test("恢复备份中途失败（清除全部数据插了进来）：清除和导入都做完、放开以后才重载", async () => {
  const bg = reloadingBackground();
  const port = bg.fake.connect("backup.import", senders.options());
  await bg.nextPart(port, 0, "note_a");
  bg.app.onWake();
  assert.ok(await until(() => bg.timers.due(BUSY_RECHECK_MS) === 1));

  assert.deepEqual(await bg.app.dispatch({ type: "data.clear", req: { scope: "all" } }, senders.options()), { ok: true, value: {} });
  // 清除全部连启用确认一起清掉，导入的连接跟着被关；没关的话下一段也会因为清过了被拒。
  port.send({ type: "part", seq: 1, kind: "notes", records: [note("note_b")] });
  assert.ok(await until(() => port.disconnected || port.posted.some((message) => (message as { type: string }).type === "port.error")));
  bg.timers.fire(BUSY_RECHECK_MS);
  assert.ok(await until(() => bg.reloads() === 1), "失败断开以后照样重载");
});
