import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createObjectStoreDriver,
  DATABASE_VERSION,
  UPGRADE_STEPS,
  type ObjectStoreDriver,
  type UpgradeStep,
} from "../../../src/platform/idb.ts";
import { DATABASE_NAME, STORE_NAMES, type StoreName } from "../../../src/shared/names.ts";
import { createMemoryDriver } from "../../helpers/memory-driver.ts";
import { createMemoryIndexedDb, type MemoryIndexedDb } from "../../helpers/memory-idb.ts";

interface Note {
  readonly id: string;
  text: string;
  readonly createdAt: number;
  readonly video?: string;
  readonly origin?: string;
}

function note(id: string, overrides: Partial<Note> = {}): Note {
  return { id, text: `笔记 ${id}`, createdAt: 1000, ...overrides };
}

function driverOn<T = Note>(indexedDB: MemoryIndexedDb, storeName: StoreName = "notes"): ObjectStoreDriver<T> {
  return createObjectStoreDriver<T>({ storeName, indexedDB });
}

test("连接被关掉并发出 close 事件：下一次读写重新打开，照常成功", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);
  await driver.write({ put: [note("n1", { text: "一条" })] });
  assert.equal(idb.openCount(), 1);

  idb.closeConnections();

  assert.deepEqual(await driver.get("n1"), note("n1", { text: "一条" }));
  assert.equal(idb.openCount(), 2);
  assert.equal(idb.staleTransactions(), 0, "收到 close 事件就作废缓存，不在关掉的连接上开事务");
});

test("close 事件没赶上：开事务撞上 InvalidStateError 时重开一次再试", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);
  await driver.write({ put: [note("n1", { text: "一条" })] });

  idb.closeConnections({ fireOnclose: false });

  assert.deepEqual(await driver.getAll(), [note("n1", { text: "一条" })]);
  assert.equal(idb.openCount(), 2);
  assert.equal(idb.staleTransactions(), 1);
});

test("别的错误照常抛出，不重开", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);
  await driver.getAll();
  idb.failNextWrite(new Error("boom"));
  await assert.rejects(driver.write({ put: [note("q1")] }), /boom/);
  assert.equal(idb.openCount(), 1);

  // 开事务时抛的别的错误也一样：这个库里没有 notes 仓库。
  const other = createMemoryIndexedDb();
  const missingStore: UpgradeStep = (db) => {
    db.createObjectStore("qa", { keyPath: "id" });
  };
  const noNotes = createObjectStoreDriver<Note>({ storeName: "notes", indexedDB: other, steps: [missingStore] });
  await assert.rejects(() => noNotes.getAll(), { name: "NotFoundError" });
  assert.equal(other.openCount(), 1);
});

test("IndexedDB 打开失败后允许重连：瞬时故障不毒化整个生命周期", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);

  idb.failNextOpen();
  await assert.rejects(() => driver.getAll(), { message: "IndexedDB 打开失败" });
  assert.deepEqual(await driver.getAll(), [], "被拒绝的打开结果不能一直缓存");
});

test("内存驱动的读写与拷贝隔离", async () => {
  const driver = createMemoryDriver<Note>("notes", [note("a")]);
  const rows = await driver.getAll();
  assert.equal(rows.length, 1);

  // 改动返回值不得影响库内数据：和 IndexedDB 的反序列化语义一致。
  const [row] = rows;
  assert.ok(row);
  row.text = "被篡改";
  const found = await driver.get("a");
  assert.equal(found?.text, "笔记 a");
  assert.ok(found);
  found.text = "也被篡改";
  assert.equal((await driver.get("a"))?.text, "笔记 a");

  // 写进去的也是拷贝，之后改传入的对象不影响库内数据。
  const written = note("b", { createdAt: 2000 });
  await driver.write({ put: [written], remove: ["a"] });
  written.text = "写完又改";
  assert.deepEqual((await driver.getAll()).map((item) => item.id), ["b"]);
  assert.equal((await driver.get("b"))?.text, "笔记 b");
});

test("IndexedDB 驱动：建库、写入、读取、删除走完整事件链", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);

  await driver.write({});
  assert.equal(idb.openCount(), 0, "没有要写的就不开库");

  assert.equal((await driver.getAll()).length, 0);
  await driver.write({ put: [note("a", { createdAt: 1 }), note("b", { createdAt: 2 })] });
  assert.equal((await driver.getAll()).length, 2);

  assert.equal((await driver.get("a"))?.text, "笔记 a");
  assert.equal(await driver.get("missing"), undefined);

  await driver.write({ put: [note("c")] });
  await driver.write({ remove: ["a"] });
  assert.deepEqual((await driver.getAll()).map((row) => row.id).sort(), ["b", "c"]);

  // 空 write 是合法的空操作。
  await driver.write({});
  await driver.write();
  await driver.write({ put: [], remove: [] });
  assert.equal((await driver.getAll()).length, 2);

  await driver.clear();
  assert.deepEqual(await driver.getAll(), []);
});

test("IndexedDB 驱动：事务失败时整体回滚且抛出原始错误", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);
  await driver.write({ put: [note("a")] });

  // 第一个写请求已经落地，第二个才失败：只有真的回滚，b 才不会留下。
  const failure = new Error("模拟磁盘配额耗尽");
  idb.failNextWrite(failure, { skip: 1 });

  await assert.rejects(
    () => driver.write({ put: [note("b")], remove: ["a"] }),
    (error) => error === failure,
  );
  assert.deepEqual((await driver.getAll()).map((row) => row.id), ["a"]);
});

test("IndexedDB 驱动：没有 indexedDB 全局时报错而不是悬空", () => {
  assert.throws(() => createObjectStoreDriver({ storeName: "notes", indexedDB: undefined }), /IndexedDB/);
});

test("IndexedDB 驱动：同一连接上的并发事务各自成立", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);

  const [, read] = await Promise.all([
    driver.write({ put: [note("a")] }),
    driver.getAll(),
    driver.write({ put: [note("b")] }),
  ]);
  assert.deepEqual(read.map((row) => row.id), ["a"], "读排在第一个写之后、第二个写之前");
  assert.equal((await driver.getAll()).length, 2);
  assert.equal(idb.openCount(), 1);
});

test("IndexedDB 驱动：写到一半同步抛错时整批撤销", async () => {
  const driver = driverOn(createMemoryIndexedDb());
  await driver.write({ put: [note("a")] });

  const noPrimaryKey = { text: "没有主键" } as unknown as Note;
  await assert.rejects(() => driver.write({ put: [note("b"), noPrimaryKey] }), { name: "DataError" });
  assert.deepEqual((await driver.getAll()).map((row) => row.id), ["a"]);
});

test("IndexedDB 驱动：未登记的仓库直接报错", () => {
  assert.throws(
    () => createObjectStoreDriver({ storeName: "drafts" as StoreName, indexedDB: createMemoryIndexedDb() }),
    /未登记的对象仓库/,
  );
});

test("IndexedDB 驱动：关掉连接以后再调用重新打开", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);
  await driver.write({ put: [note("a")] });

  driver.close();
  for (let turn = 0; turn < 100 && idb.openConnections() > 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(idb.openConnections(), 0, "连接真的关了");

  assert.equal((await driver.getAll()).length, 1);
  assert.equal(idb.openCount(), 2);
  assert.equal(idb.staleTransactions(), 0, "关掉时就作废了缓存");
});

test("IndexedDB 驱动：按索引取，结果按索引值排序，缺索引字段的记录不进索引", async () => {
  const driver = driverOn(createMemoryIndexedDb());
  await driver.write({
    put: [
      note("late", { createdAt: 300, video: "youtube:sample" }),
      note("early", { createdAt: 100, video: "youtube:sample" }),
      note("other", { createdAt: 200, video: "youtube:other" }),
      note("orphan", { createdAt: 50 }),
    ],
  });

  const ids = (rows: readonly Note[]) => rows.map((row) => row.id);
  assert.deepEqual(ids(await driver.getAllByIndex("byVideo", "youtube:sample")), ["early", "late"]);
  assert.deepEqual(ids(await driver.getAllByIndex("byCreated")), ["orphan", "early", "other", "late"]);
  assert.deepEqual(await driver.getAllByIndex("byVideo", "youtube:none"), []);
  await assert.rejects(() => driver.getAllByIndex("byMissing"), { name: "NotFoundError" });
});

test("第 1 版建齐七个仓库，主键和索引都对", async () => {
  const idb = createMemoryIndexedDb();
  await driverOn(idb).getAll();

  const database = idb.inspect("jianmu");
  assert.equal(DATABASE_NAME, "jianmu");
  assert.equal(DATABASE_VERSION, 1);
  assert.equal(database?.version, 1);
  const shape = Object.fromEntries(
    Object.entries(database?.stores ?? {}).map(([name, { keyPath, indexes }]) => [name, { keyPath, indexes }]),
  );
  assert.deepEqual(shape, {
    notes: { keyPath: "id", indexes: { byVideo: "video", byCreated: "createdAt" } },
    overviews: { keyPath: "videoKey", indexes: { byUpdated: "updatedAt" } },
    qa: { keyPath: "id", indexes: { byVideo: "video", byCreated: "createdAt" } },
    cache: { keyPath: "videoKey", indexes: { byTimestamp: "timestamp" } },
    translations: { keyPath: "id", indexes: { byVideo: "video" } },
    imports: { keyPath: "videoKey", indexes: {} },
    channels: { keyPath: "channelKey", indexes: {} },
  });
  assert.deepEqual(Object.keys(shape).sort(), [...STORE_NAMES].sort());
});

test("每个仓库都能按自己的主键读写", async () => {
  const idb = createMemoryIndexedDb();
  const records: Record<StoreName, Record<string, string>> = {
    notes: { id: "note_1" },
    overviews: { videoKey: "youtube:sample" },
    qa: { id: "qa_1" },
    cache: { videoKey: "youtube:sample" },
    translations: { id: "youtube:sample|zh-Hans" },
    imports: { videoKey: "youtube:sample" },
    channels: { channelKey: "youtube:channel" },
  };
  for (const name of STORE_NAMES) {
    const driver = driverOn<Record<string, string>>(idb, name);
    const record = records[name];
    await driver.write({ put: [record] });
    assert.deepEqual(await driver.get(Object.values(record)[0] ?? ""), record, name);
  }
});

// 假想的第 2 版：加一个仓库，给已有的仓库加一个索引。
function secondVersion(calls?: { count: number }): UpgradeStep {
  return (db, tx) => {
    if (calls) calls.count += 1;
    db.createObjectStore("drafts", { keyPath: "id" });
    tx.objectStore("notes").createIndex("byOrigin", "origin");
  };
}

const VERSION_2 = [...UPGRADE_STEPS, secondVersion()];

function driverAtVersion2(indexedDB: MemoryIndexedDb, steps: readonly UpgradeStep[] = VERSION_2): ObjectStoreDriver<Note> {
  return createObjectStoreDriver<Note>({ storeName: "notes", indexedDB, steps });
}

test("假想第 2 版：加一个仓库、加一个索引，旧记录不丢", async () => {
  const idb = createMemoryIndexedDb();
  const first = driverOn(idb);
  await first.write({ put: [note("a", { origin: "legacy" }), note("b", { origin: "user" }), note("c")] });
  first.close();

  const second = driverAtVersion2(idb);
  assert.deepEqual((await second.getAll()).map((row) => row.id), ["a", "b", "c"], "旧记录都在");
  assert.equal((await second.get("a"))?.text, "笔记 a", "内容不变");
  assert.deepEqual(
    (await second.getAllByIndex("byOrigin", "legacy")).map((row) => row.id),
    ["a"],
    "新索引能查到升级前写入的记录",
  );
  assert.deepEqual((await second.getAllByIndex("byVideo")).length, 0, "第 1 版的索引还在");

  const database = idb.inspect(DATABASE_NAME);
  assert.equal(database?.version, 2);
  assert.deepEqual(database?.stores["drafts"], { keyPath: "id", indexes: {}, rows: [] });
  assert.deepEqual(Object.keys(database?.stores ?? {}).sort(), [...STORE_NAMES, "drafts"].sort());
});

test("假想第 2 版：全新安装逐级跑完两步", async () => {
  const idb = createMemoryIndexedDb();
  const second = driverAtVersion2(idb);
  await second.write({ put: [note("a", { origin: "user" })] });

  assert.equal((await second.getAllByIndex("byOrigin", "user")).length, 1);
  assert.equal(idb.inspect(DATABASE_NAME)?.version, 2);
  assert.ok(idb.inspect(DATABASE_NAME)?.stores["channels"], "第 1 步也跑了");
});

test("假想第 2 版：第 1 步只建第 1 版的仓库，不跟着仓库名单变", async () => {
  const names = STORE_NAMES as unknown as string[];
  names.push("drafts");
  try {
    const idb = createMemoryIndexedDb();
    await driverAtVersion2(idb).getAll();
    assert.deepEqual(idb.inspect(DATABASE_NAME)?.stores["drafts"]?.rows, [], "第 2 步能建出新仓库，全新安装不报错");
  } finally {
    names.pop();
  }
});

test("假想第 2 版：只跑缺的步骤，已经升过的不重跑", async () => {
  const idb = createMemoryIndexedDb();
  let firstRuns = 0;
  const calls = { count: 0 };
  const countedFirst: UpgradeStep = (db, tx) => {
    firstRuns += 1;
    UPGRADE_STEPS[0]?.(db, tx);
  };
  const steps = [countedFirst, secondVersion(calls)];

  const atVersion1 = createObjectStoreDriver<Note>({ storeName: "notes", indexedDB: idb, steps: [countedFirst] });
  await atVersion1.getAll();
  atVersion1.close();
  assert.deepEqual([firstRuns, calls.count], [1, 0]);

  const atVersion2 = driverAtVersion2(idb, steps);
  await atVersion2.getAll();
  assert.deepEqual([firstRuns, calls.count], [1, 1], "第 1 步不重跑");

  atVersion2.close();
  await driverAtVersion2(idb, steps).getAll();
  assert.deepEqual([firstRuns, calls.count], [1, 1], "版本对上了就不升级");
});

test("假想第 2 版：开着的旧连接让出来，升级不被挡住，旧驱动下次重新打开", async () => {
  const idb = createMemoryIndexedDb();
  const first = driverOn(idb);
  await first.write({ put: [note("a")] });

  const second = driverAtVersion2(idb);
  assert.equal((await second.getAll()).length, 1, "旧驱动没有 close，也升上去了");
  assert.equal(idb.inspect(DATABASE_NAME)?.version, 2);

  await assert.rejects(() => first.getAll(), { name: "VersionError" }, "旧版本的代码打不开新库");
  assert.equal(idb.staleTransactions(), 0, "让出连接时就作废了缓存");
});

test("连接悄悄断了时，并发的操作共用同一次重开，不留多余的连接", async () => {
  const idb = createMemoryIndexedDb();
  const driver = driverOn(idb);
  await driver.getAll();
  idb.closeConnections({ fireOnclose: false });

  await Promise.all([driver.getAll(), driver.getAll()]);
  assert.equal(idb.openConnections(), 1, "两个操作共用一条新连接");
  driver.close();
  for (let turn = 0; turn < 100 && idb.openConnections() > 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(idb.openConnections(), 0, "关掉驱动后一条不留");
});

test("升级被别的连接挡住：明确报错不挂死，对方让出来以后能再试", async () => {
  const idb = createMemoryIndexedDb();
  const request = idb.open(DATABASE_NAME, DATABASE_VERSION);
  const holder = await new Promise<typeof request.result>((resolve, reject) => {
    request.onupgradeneeded = ({ oldVersion }) => {
      for (const step of UPGRADE_STEPS.slice(oldVersion)) step(request.result, request.transaction!);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打开失败"));
  });

  const second = driverAtVersion2(idb);
  await assert.rejects(() => second.getAll(), /IndexedDB 正被其他窗口占用/);

  holder.close();
  assert.deepEqual(await second.getAll(), []);
  assert.equal(idb.inspect(DATABASE_NAME)?.version, 2);

  // 被挡住的那次请求后来也会成功，它的连接没人持有，不能留着。
  for (let turn = 0; turn < 100 && idb.openConnections() > 1; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(idb.openConnections(), 1, "只留下重试拿到的那条连接");
  second.close();
  for (let turn = 0; turn < 100 && idb.openConnections() > 0; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(idb.openConnections(), 0, "关掉驱动后一条不留");
});

test("数据库比代码新：报错不动数据，下一次还会重新打开", async () => {
  const idb = createMemoryIndexedDb();
  const second = driverAtVersion2(idb);
  await second.write({ put: [note("a")] });
  second.close();

  const first = driverOn(idb);
  await assert.rejects(() => first.getAll(), { name: "VersionError" });
  await assert.rejects(() => first.getAll(), { name: "VersionError" });
  assert.equal(idb.openCount(), 3);
  assert.equal(idb.inspect(DATABASE_NAME)?.stores["notes"]?.rows.length, 1);
});

test("升级步骤抛错：报错，版本和旧记录都留在原地", async () => {
  const idb = createMemoryIndexedDb();
  const first = driverOn(idb);
  await first.write({ put: [note("a")] });
  first.close();

  const broken: UpgradeStep = (db) => {
    db.createObjectStore("drafts", { keyPath: "id" });
    throw new Error("升级到一半出错");
  };
  const second = driverAtVersion2(idb, [...UPGRADE_STEPS, broken]);
  await assert.rejects(() => second.getAll(), { name: "AbortError" });

  const database = idb.inspect(DATABASE_NAME);
  assert.equal(database?.version, 1);
  assert.equal(database?.stores["drafts"], undefined);
  assert.equal(database?.stores["notes"]?.rows.length, 1);
});
