// 打开就出结论的尝试记录：改动排成一条队，前后脚的改动不互相盖掉；清除全部数据之后才回来的改动不写回；
// 只清缓存、只删笔记都不影响它；清除撞上排着的改动时，轮到它再核对一次；写不进存储时报给调用方，后面的改动照常排。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLedger } from "../../../../src/background/services/auto-ledger.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import { AUTO_LEDGER_KEY } from "../../../../src/shared/names.ts";
import { holdWrites } from "../../../helpers/held-writes.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";
import { until } from "../../../helpers/wait-until.ts";

const NOW = 1_800_000_000_000;

function setup() {
  const storage = memoryStorage();
  const guard = createClearGuard();
  const ledger = createLedger({ storage, guard, now: () => NOW, log: { warn() {}, error() {} } });
  return { storage, guard, ledger };
}

test("前后脚的几次改动排着做，每一次都看到前一次写下的", async () => {
  const { ledger, guard } = setup();
  const since = guard.epoch();
  const results = await Promise.all(["a", "b", "c"].map((key) => ledger.change(since, (current) => ({ ...current, tried: [...current.tried, key] }))));
  assert.deepEqual(results, [true, true, true]);
  assert.deepEqual((await ledger.read()).tried, ["a", "b", "c"]);
});

test("改动回 null 时不写，回 false", async () => {
  const { ledger, guard, storage } = setup();
  assert.equal(await ledger.change(guard.epoch(), () => null), false);
  assert.equal(storage.data[AUTO_LEDGER_KEY], undefined);
});

test("清除全部数据之后才回来的改动不写回，回 false；只清缓存的照常写", async () => {
  const { ledger, guard, storage } = setup();
  const before = guard.epoch();
  await guard.clear("all", () => storage.remove(AUTO_LEDGER_KEY));
  let asked = false;
  const stale = await ledger.change(before, (current) => {
    asked = true;
    return { ...current, tried: ["stale"] };
  });
  assert.equal(stale, false);
  assert.equal(asked, false, "清过了就不读也不改");
  assert.equal(storage.data[AUTO_LEDGER_KEY], undefined);

  const fresh = guard.epoch();
  await guard.clear("cache", () => undefined);
  assert.equal(await ledger.change(fresh, (current) => ({ ...current, tried: ["fresh"] })), true);
  assert.deepEqual((await ledger.read()).tried, ["fresh"]);
});

test("只删了笔记：清除之前开始的改动照常写", async () => {
  const { ledger, guard } = setup();
  const before = guard.epoch();
  await guard.clear("notes", () => undefined);
  assert.equal(await ledger.change(before, (current) => ({ ...current, tried: ["kept"] })), true);
  assert.deepEqual((await ledger.read()).tried, ["kept"]);
});

test("清除全部数据撞上正在写和排着的改动：正在写的写完再清，排着的轮到时再核对一次，不写回", async () => {
  const { ledger, guard, storage } = setup();
  const since = guard.epoch();
  const held = holdWrites(storage);
  const first = ledger.change(since, (current) => ({ ...current, tried: ["first"] }));
  const second = ledger.change(since, (current) => ({ ...current, tried: [...current.tried, "second"] }));
  assert.ok(await until(() => held.started() === 1), "第一次进了存储，第二次排在后面");
  const clearing = guard.clear("all", () => storage.remove(AUTO_LEDGER_KEY));
  held.release();
  await clearing;
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(held.started(), 1, "排着的那次没再写");
  assert.equal(storage.data[AUTO_LEDGER_KEY], undefined);
});

test("写不进存储时报给调用方，后面的改动照常排", async () => {
  const { ledger, guard, storage } = setup();
  const write = storage.set;
  Object.assign(storage, { set: () => Promise.reject(new Error("存不进去")) });
  await assert.rejects(ledger.change(guard.epoch(), (current) => ({ ...current, tried: ["lost"] })), /存不进去/);
  Object.assign(storage, { set: write });
  assert.equal(await ledger.change(guard.epoch(), (current) => ({ ...current, tried: [...current.tried, "kept"] })), true);
  assert.deepEqual((await ledger.read()).tried, ["kept"]);
});
