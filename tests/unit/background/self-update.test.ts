// 文件换了就自己重新加载：标识一样不重载，不一样重载；有工作在跑先等做完；一分钟最多看一次；
// 同一个新标识重载几次还对不上就停下，不来回重载；读不出文件不重载。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUSY_RECHECK_MS, CHECK_INTERVAL_MS, createSelfUpdate, RELOAD_ATTEMPTS, RELOAD_WINDOW_MS, type ReloadRecord } from "../../../src/background/self-update.ts";
import { manualTimers } from "../../helpers/manual-timers.ts";
import { until } from "../../helpers/wait-until.ts";

function setup(options: { disk?: string | null | (() => Promise<string | null>); busy?: () => boolean; record?: ReloadRecord | null; onLoadRecord?: () => void; onSaveRecord?: () => void } = {}) {
  const timers = manualTimers(1_000_000);
  let disk = options.disk === undefined ? "new-build" : options.disk;
  let record = options.record ?? null;
  let reads = 0;
  const reloads: number[] = [];
  const warned: unknown[][] = [];
  const update = createSelfUpdate({
    buildId: "old-build",
    readBuildId: async () => {
      reads += 1;
      return typeof disk === "function" ? disk() : disk;
    },
    busy: options.busy ?? (() => false),
    reload: () => void reloads.push(timers.now()),
    loadRecord: async () => (options.onLoadRecord?.(), record),
    saveRecord: async (next) => {
      options.onSaveRecord?.();
      record = next;
    },
    now: timers.now,
    setTimeout: timers.setTimeout,
    log: { warn: (...args: unknown[]) => void warned.push(args) },
  });
  return {
    update,
    timers,
    reloads,
    warned,
    reads: () => reads,
    record: () => record,
    setDisk: (value: string | null) => {
      disk = value;
    },
  };
}

test("磁盘上的标识和编进去的一样：不重载；读不出、读出空的也不重载", async () => {
  for (const disk of ["old-build", "old-build\n", null, "", async () => Promise.reject(new Error("读不到"))] as const) {
    const h = setup({ disk });
    await h.update.check();
    assert.deepEqual(h.reloads, [], String(disk));
  }
});

test("标识不一样：重新加载，记下对着哪个标识重载过", async () => {
  const h = setup({ disk: "new-build\n" });
  await h.update.check();
  assert.equal(h.reloads.length, 1);
  assert.deepEqual(h.record(), { target: "new-build", count: 1, since: h.timers.now() });
  // 已经要重载了：之后的事件不再看。
  h.timers.advance(CHECK_INTERVAL_MS);
  await h.update.check();
  assert.equal(h.reloads.length, 1);
});

test("一分钟最多看一次文件", async () => {
  const h = setup({ disk: "old-build" });
  await h.update.check();
  await h.update.check();
  h.timers.advance(CHECK_INTERVAL_MS - 1);
  await h.update.check();
  assert.equal(h.reads(), 1);
  h.setDisk("new-build");
  h.timers.advance(1);
  await h.update.check();
  assert.equal(h.reads(), 2);
  assert.equal(h.reloads.length, 1);
});

test("有工作在跑：先不重载，隔一会儿再看，做完了才重载", async () => {
  let busy = true;
  const h = setup({ busy: () => busy });
  await h.update.check();
  assert.deepEqual(h.reloads, []);
  h.timers.advance(BUSY_RECHECK_MS);
  assert.ok(await until(() => h.reads() === 2));
  assert.deepEqual(h.reloads, [], "还在忙");
  busy = false;
  h.timers.advance(BUSY_RECHECK_MS);
  assert.ok(await until(() => h.reloads.length === 1));
});

test("等的时候文件又换回原来的：不重载", async () => {
  let busy = true;
  const h = setup({ busy: () => busy });
  await h.update.check();
  busy = false;
  h.setDisk("old-build");
  h.timers.advance(BUSY_RECHECK_MS);
  assert.ok(await until(() => h.reads() === 2));
  assert.deepEqual(h.reloads, []);
});

test("同一个新标识重载了几次还对不上：先停下，不再重载；换了别的新标识、或者过了一段时间，照常重载", async () => {
  const now = 1_000_000;
  const stuck = setup({ record: { target: "new-build", count: RELOAD_ATTEMPTS, since: now - 1000 } });
  await stuck.update.check();
  assert.deepEqual(stuck.reloads, []);
  assert.equal(stuck.warned.length, 1);

  const counting = setup({ record: { target: "new-build", count: RELOAD_ATTEMPTS - 1, since: now - 1000 } });
  await counting.update.check();
  assert.equal(counting.reloads.length, 1);
  assert.equal(counting.record()?.count, RELOAD_ATTEMPTS);

  const other = setup({ disk: "newer-build", record: { target: "new-build", count: RELOAD_ATTEMPTS, since: now - 1000 } });
  await other.update.check();
  assert.equal(other.reloads.length, 1);
  assert.deepEqual(other.record(), { target: "newer-build", count: 1, since: now });

  const later = setup({ record: { target: "new-build", count: RELOAD_ATTEMPTS, since: now - RELOAD_WINDOW_MS - 1 } });
  await later.update.check();
  assert.equal(later.reloads.length, 1);
});

test("读写重载记录的工夫里开始了新的工作：先不重载，做完了再重载", async () => {
  for (const when of ["load", "save"] as const) {
    let busy = false;
    let started = false;
    // 只在第一次读写记录时开始一项工作。
    const start = () => void (started || ((started = true), (busy = true)));
    const h = setup({ busy: () => busy, ...(when === "load" ? { onLoadRecord: start } : { onSaveRecord: start }) });
    await h.update.check();
    assert.deepEqual(h.reloads, [], when);
    busy = false;
    h.timers.advance(BUSY_RECHECK_MS);
    assert.ok(await until(() => h.reloads.length === 1));
  }
});
