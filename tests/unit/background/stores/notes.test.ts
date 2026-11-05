import assert from "node:assert/strict";
import { test } from "node:test";
import { createNoteStore, type NoteView } from "../../../../src/background/stores/notes.ts";
import { createClearGuard, NO_CLEAR_GUARD, type ClearGuard } from "../../../../src/core/clear-guard.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../../../src/core/video-ref.ts";
import type { ObjectStoreDriver } from "../../../../src/platform/idb.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

const VIDEO_BASE = "https://video.example/";
const EVIL_URL = "https://login.example/phish?t=65";
const VIDEO_ID = "BV1Sample000";
const part = (segment: number): VideoKey => videoKey({ platform: "bilibili", videoId: VIDEO_ID, segment });

const canonicalUrl = ({ videoId, segment = 1 }: VideoRef, atSec = 0): string =>
  `${VIDEO_BASE}${videoId}?p=${segment}&t=${atSec}`;

function note(id: string, overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    id,
    kind: "note",
    origin: "user",
    video: part(1),
    snapshot: { title: "番茄种植课", author: "老园丁" },
    atSec: 12,
    text: `笔记 ${id}`,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// 库里读出来的行不一定对得上记录类型，这里按坏记录造。
const badRow = (id: string, fields: Record<string, unknown>): NoteRecord => ({ ...note(id), ...fields }) as NoteRecord;

interface HarnessOptions {
  readonly seed?: readonly NoteRecord[];
  readonly guard?: ClearGuard;
  readonly wrap?: (inner: ObjectStoreDriver<NoteRecord>) => ObjectStoreDriver<NoteRecord>;
}

function harness({ seed = [], guard = NO_CLEAR_GUARD, wrap = (inner) => inner }: HarnessOptions = {}) {
  const driver = createMemoryDriver<NoteRecord>("notes", seed);
  return { driver, store: createNoteStore({ driver: wrap(driver), guard, canonicalUrl }) };
}

const ids = (notes: readonly NoteRecord[]): string[] => notes.map((row) => row.id);

test("仓储层过滤坏记录并按创建时间倒序", async () => {
  const { store } = harness({
    seed: [
      note("old", { createdAt: 100 }),
      badRow("   ", { createdAt: 110 }),
      badRow("bad-video", { createdAt: 120, video: "认不出" }),
      note("new", { createdAt: 300 }),
      badRow("bad-time", { createdAt: 130, atSec: -1 }),
      note("mid", { createdAt: 200 }),
      badRow("bad-text", { createdAt: 140, text: 42 }),
    ],
  });

  assert.deepEqual(ids(await store.all()), ["new", "mid", "old"]);

  await store.commit({ put: [note("newer", { createdAt: 400 })], remove: ["old"] });
  assert.deepEqual(ids(await store.all()), ["newer", "new", "mid"]);
});

test("读笔记时链接也现拼：旧版本已经导入库里的坏链接不会交给侧边栏", async () => {
  const row = badRow("evil", { video: part(2), atSec: 65, url: EVIL_URL, timestampedUrl: EVIL_URL });
  const { store } = harness({ seed: [row] });
  const expected = `${VIDEO_BASE}${VIDEO_ID}?p=2&t=65`;

  const reads: NoteView[][] = [await store.all(), await store.byVideo(part(2))];
  for (const notes of reads) {
    assert.equal(notes[0]?.url, expected);
    assert.equal(JSON.stringify(notes).includes("login.example"), false, "存着的链接字段不往外带");
  }
});

test("读出来的是记录本身加现拼的链接，没有的可选字段不补", async () => {
  const quoted = note("quoted", { quote: "番茄要打顶" });
  const { store } = harness({ seed: [quoted] });

  assert.deepEqual(await store.all(), [{ ...quoted, url: `${VIDEO_BASE}${VIDEO_ID}?p=1&t=12` }]);
});

test("写回时存着的链接也写不进去：现拼的链接和旧字段都不落库", async () => {
  const { driver, store } = harness({ seed: [badRow("evil", { timestampedUrl: EVIL_URL })] });

  const [read] = await store.all();
  assert.ok(read);
  await store.commit({ put: [{ ...read, text: "改过" }] });
  await store.update(([current]) => ({ put: current ? [{ ...current, updatedAt: 2000 }] : [] }));

  assert.deepEqual(await driver.getAll(), [note("evil", { text: "改过", updatedAt: 2000 })]);
});

test("写入一批时坏记录逐条跳过，好的照常写", async () => {
  const { driver, store } = harness();

  assert.equal(await store.commit({ put: [badRow("bad-video", { video: "认不出" }), note("good")] }), true);

  assert.deepEqual(ids(await driver.getAll()), ["good"]);
});

test("按视频取：只给这个视频的，新的在前", async () => {
  const { store } = harness({
    seed: [
      note("a", { createdAt: 100 }),
      note("b", { createdAt: 300 }),
      note("c", { createdAt: 200, video: part(2) }),
      note("d", { createdAt: 200 }),
    ],
  });

  assert.deepEqual(ids(await store.byVideo(part(1))), ["b", "d", "a"]);
  assert.deepEqual(ids(await store.byVideo(part(2))), ["c"]);
  assert.deepEqual(await store.byVideo(part(3)), []);
});

test("读—改—写在写队列里一次做完：并发的新增一条不丢", async () => {
  const { store } = harness();

  const added = await Promise.all(
    ["a", "b", "c"].map((id, index) =>
      store.update((current) => ({
        put: [note(id, { createdAt: index + 1 })],
        result: current.length,
      })),
    ),
  );

  assert.deepEqual(added, [0, 1, 2], "每次都读到前一次写下的");
  assert.deepEqual(ids(await store.all()), ["c", "b", "a"]);
});

test("等模型的工夫清除了全部数据：回来的写入不写回", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard });
  const since = guard.epoch();
  await guard.clear("all", () => {});

  assert.equal(await store.commit({ put: [note("late")] }, { since }), false);
  let planned = false;
  const result = await store.update(
    () => {
      planned = true;
      return { put: [note("late")], result: "写了" };
    },
    { since },
  );

  assert.equal(result, null);
  assert.equal(planned, false, "清除过就不调用 plan");
  assert.deepEqual(await driver.getAll(), []);
});

test("只清除了缓存：笔记照常写", async () => {
  const guard = createClearGuard();
  const { store } = harness({ guard });
  const since = guard.epoch();
  await guard.clear("cache", () => {});

  assert.equal(await store.commit({ put: [note("kept")] }, { since }), true);
  assert.equal(await store.update(() => ({ put: [note("also-kept")], result: "写了" }), { since }), "写了");
  assert.deepEqual(ids(await store.all()), ["kept", "also-kept"]);
});

test("排在写队列里时清除了全部数据：调用方没记代数也不写回", async () => {
  const guard = createClearGuard();
  const holding = deferred();
  const writing = deferred();
  const { driver, store } = harness({
    guard,
    wrap: (inner) => ({
      ...inner,
      async write(change) {
        writing.resolve();
        await holding.promise;
        await inner.write(change);
      },
    }),
  });

  const first = store.commit({ put: [note("first")] });
  await writing.promise;
  const queued = store.commit({ put: [note("queued")] });
  const clearing = guard.clear("all", () => driver.clear());
  holding.resolve();

  assert.deepEqual(await Promise.all([first, queued]), [true, false]);
  await clearing;
  assert.deepEqual(await driver.getAll(), []);
});

test("正在写的那一下，清除等它写完才动手", async () => {
  const guard = createClearGuard();
  const holding = deferred();
  const writing = deferred();
  const order: string[] = [];
  const { driver, store } = harness({
    guard,
    wrap: (inner) => ({
      ...inner,
      async write(change) {
        writing.resolve();
        await holding.promise;
        await inner.write(change);
        order.push("write");
      },
    }),
  });

  const saving = store.commit({ put: [note("n1")] });
  await writing.promise;
  const clearing = guard.clear("all", async () => {
    await driver.clear();
    order.push("clear");
  });
  await nextTurn();
  assert.deepEqual(order, [], "清除在等正在写的那一下");
  holding.resolve();
  await Promise.all([saving, clearing]);

  assert.deepEqual(order, ["write", "clear"]);
  assert.deepEqual(await driver.getAll(), [], "写完的那份随后被清掉，不会留到清除之后");
});

test("清除进行中才开始的写入等清完再写，读—改—写读到的是清完的数据", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard, seed: [note("before")] });
  const holding = deferred();
  const running = deferred();
  const clearing = guard.clear("all", async () => {
    running.resolve();
    await holding.promise;
    await driver.clear();
  });
  await running.promise;

  const seen: string[][] = [];
  const updating = store.update((current) => {
    seen.push(ids(current));
    return { put: [note("after")] };
  });
  holding.resolve();
  await Promise.all([clearing, updating]);

  assert.deepEqual(seen, [[]], "清除之前的笔记读不到，也写不回去");
  assert.deepEqual(ids(await store.all()), ["after"]);
});
