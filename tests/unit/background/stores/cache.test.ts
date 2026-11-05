import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  createCacheStore,
  type CacheEntry,
} from "../../../../src/background/stores/cache.ts";
import { createClearGuard, NO_CLEAR_GUARD, type ClearGuard } from "../../../../src/core/clear-guard.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import type { ObjectStoreDriver } from "../../../../src/platform/idb.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

interface Payload {
  readonly transcript: readonly string[];
}

type Entry = CacheEntry<Payload>;

const VIDEO_ID = "BV1Sample000";
const part = (segment: number): VideoKey => videoKey({ platform: "bilibili", videoId: VIDEO_ID, segment });
const KEY = part(1);
const entry = (segment: number, timestamp: number): Entry => ({ videoKey: part(segment), timestamp, transcript: [] });
const ascending = (count: number): Entry[] => Array.from({ length: count }, (_, i) => entry(i + 1, i + 1));

interface HarnessOptions {
  readonly seed?: readonly Entry[];
  readonly maxEntries?: number;
  readonly guard?: ClearGuard;
  readonly wrap?: (inner: ObjectStoreDriver<Entry>) => ObjectStoreDriver<Entry>;
}

function harness({ seed = [], maxEntries, guard = NO_CLEAR_GUARD, wrap = (inner) => inner }: HarnessOptions = {}) {
  const clock = { now: 0 };
  const driver = createMemoryDriver<Entry>("cache", seed);
  const store = createCacheStore<Payload>({
    driver: wrap(driver),
    guard,
    now: () => clock.now,
    ...(maxEntries === undefined ? {} : { maxEntries }),
  });
  return { clock, driver, store };
}

const keysIn = async (driver: ObjectStoreDriver<Entry>): Promise<string[]> =>
  (await driver.getAll()).map((row) => row.videoKey);

test("缓存键按分 P 区分", async () => {
  const { driver, store } = harness();
  await store.save(part(1), { transcript: [] });
  await store.save(part(3), { transcript: [] });
  assert.deepEqual(await keysIn(driver), [`bilibili:${VIDEO_ID}:p1`, `bilibili:${VIDEO_ID}:p3`]);
  assert.equal(videoKey({ platform: "bilibili", videoId: VIDEO_ID }), part(1), "不写分 P 就是第 1 P");
});

test("写入后可读回，并带上写入时间", async () => {
  const { clock, store } = harness();
  clock.now = 1000;
  await store.save(KEY, { transcript: ["hi"] });

  clock.now = 2000;
  const loaded = await store.load(KEY);
  assert.equal(loaded?.transcript[0], "hi");
  assert.equal(loaded?.timestamp, 1000);
  assert.equal(loaded?.videoKey, KEY);
});

test("不同分 P 互不覆盖", async () => {
  const { store } = harness();
  await store.save(part(1), { transcript: ["p1"] });
  await store.save(part(2), { transcript: ["p2"] });

  assert.deepEqual((await store.load(part(1)))?.transcript, ["p1"]);
  assert.deepEqual((await store.load(part(2)))?.transcript, ["p2"]);
});

test("未命中返回 null", async () => {
  const { store } = harness();
  assert.equal(await store.load(KEY), null);
});

test("超过 30 天的条目读取时失效并被删除", async () => {
  const { clock, driver, store } = harness();
  await store.save(KEY, { transcript: ["old"] });

  clock.now = CACHE_TTL_MS + 1;
  assert.equal(await store.load(KEY), null);
  assert.equal((await driver.getAll()).length, 0, "过期条目应被清掉");
});

test("刚好卡在 30 天边界仍然有效", async () => {
  const { clock, store } = harness();
  await store.save(KEY, { transcript: ["edge"] });

  clock.now = CACHE_TTL_MS;
  assert.ok(await store.load(KEY));
});

test("超出上限时淘汰最旧的条目", async () => {
  const { clock, driver, store } = harness({ seed: ascending(5), maxEntries: 3 });
  clock.now = 10;

  await store.evict();

  assert.deepEqual(await keysIn(driver), [part(3), part(4), part(5)]);
});

test("过期条目先于 LRU 被清理", async () => {
  const { clock, driver, store } = harness({
    seed: [entry(1, 1_000_000), entry(2, 0)],
    maxEntries: 10,
  });
  clock.now = CACHE_TTL_MS + 1_000_000;

  assert.deepEqual(await store.evict(), [part(2)]);
  assert.deepEqual(await keysIn(driver), [part(1)]);
});

test("写入时顺带做一次淘汰", async () => {
  const { clock, driver, store } = harness({ seed: ascending(20), maxEntries: 20 });
  clock.now = 100;

  await store.save(part(21), { transcript: [] });

  const keys = await keysIn(driver);
  assert.equal(keys.length, 20);
  assert.ok(keys.includes(part(21)), "新条目应保留");
  assert.ok(!keys.includes(part(1)), "最旧的条目应被淘汰");
});

test("evict:false 跳过淘汰——批次回写不该每次触发清理", async () => {
  const { clock, driver, store } = harness({ seed: ascending(20), maxEntries: 20 });
  clock.now = 100;

  await store.save(part(21), { transcript: [] }, { evict: false });

  // 超了上限也不动别的条目：这类写入只更新已有内容，淘汰留给新增条目的那次。
  const keys = await keysIn(driver);
  assert.equal(keys.length, 21);
  assert.ok(keys.includes(part(21)));
  assert.ok(keys.includes(part(1)), "evict:false 时不应淘汰任何条目");
});

test("remove 精确删除单条", async () => {
  const { store } = harness();
  await store.save(part(1), { transcript: [] });
  await store.save(part(2), { transcript: [] });

  await store.remove(part(1));

  assert.equal(await store.load(part(1)), null);
  assert.ok(await store.load(part(2)));
});

test("不指定上限时留 60 条", async () => {
  assert.equal(CACHE_MAX_ENTRIES, 60);
  const { clock, driver, store } = harness({ seed: ascending(CACHE_MAX_ENTRIES) });
  clock.now = 100;

  await store.save(part(61), { transcript: [] });

  const keys = await keysIn(driver);
  assert.equal(keys.length, CACHE_MAX_ENTRIES);
  assert.ok(!keys.includes(part(1)));
});

test("YouTube 的键和 B 站的键各存各的", async () => {
  const { store } = harness();
  const youtube = videoKey({ platform: "youtube", videoId: "sample_id" });
  await store.save(KEY, { transcript: ["B 站"] });
  await store.save(youtube, { transcript: ["YouTube"] });

  assert.deepEqual((await store.load(youtube))?.transcript, ["YouTube"]);
  assert.deepEqual((await store.load(KEY))?.transcript, ["B 站"]);
});

test("缓存出问题不挡主流程：写不进去回 false，读不出来回 null", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const failed = new Error("读写出错");
  const { store } = harness({
    wrap: (inner) => ({
      ...inner,
      get: () => Promise.reject(failed),
      write: () => Promise.reject(failed),
    }),
  });

  assert.equal(await store.save(KEY, { transcript: [] }), false);
  assert.equal(await store.load(KEY), null);
  assert.equal(logged.mock.callCount(), 2);
});

test("淘汰失败不影响这次写入", async (t) => {
  t.mock.method(console, "error", () => {});
  const { store } = harness({
    wrap: (inner) => ({ ...inner, getAllByIndex: () => Promise.reject(new Error("读写出错")) }),
  });

  assert.equal(await store.save(KEY, { transcript: ["留下"] }), true);
  assert.deepEqual(await store.evict(), []);
  assert.deepEqual((await store.load(KEY))?.transcript, ["留下"]);
});

test("读到过期条目、排队删除的工夫写进了新内容：新内容留下", async () => {
  const arrived = deferred();
  const release = deferred();
  let firstRead = true;
  const { clock, store } = harness({
    seed: [entry(1, 0)],
    wrap: (inner) => ({
      ...inner,
      async get(key) {
        const row = await inner.get(key);
        if (firstRead) {
          firstRead = false;
          arrived.resolve();
          await release.promise;
        }
        return row;
      },
    }),
  });
  clock.now = CACHE_TTL_MS + 1;

  const loading = store.load(part(1));
  await arrived.promise;
  await store.save(part(1), { transcript: ["新"] });
  release.resolve();

  assert.equal(await loading, null, "这次读取拿到的是过期的那份");
  assert.deepEqual((await store.load(part(1)))?.transcript, ["新"]);
});

test("读—改—写在写队列里一次做完：并发的更新一条不丢", async () => {
  const { store } = harness();
  await store.save(KEY, { transcript: [] });

  await Promise.all(
    ["一", "二", "三"].map((line) =>
      store.update(KEY, (current) => ({ transcript: [...(current?.transcript ?? []), line] })),
    ),
  );

  assert.deepEqual((await store.load(KEY))?.transcript, ["一", "二", "三"]);
});

test("读—改—写：原样交回或交回 null 不写，过期的条目当作没有", async () => {
  const writes: unknown[] = [];
  const { clock, driver, store } = harness({
    seed: [entry(1, 0)],
    wrap: (inner) => ({
      ...inner,
      async write(change) {
        writes.push(change);
        await inner.write(change);
      },
    }),
  });

  const kept = await store.update(part(1), (current) => current);
  assert.equal(kept?.videoKey, part(1));
  assert.equal(await store.update(part(2), () => null), null);
  assert.deepEqual(writes, []);

  clock.now = CACHE_TTL_MS + 1;
  const seen: (Entry | null)[] = [];
  const written = await store.update(part(1), (current) => {
    seen.push(current);
    return { transcript: ["新"] };
  });
  assert.deepEqual(seen, [null]);
  assert.equal(written?.timestamp, CACHE_TTL_MS + 1);
  assert.deepEqual((await driver.get(part(1)))?.transcript, ["新"]);
});

test("读—改—写写不进去时抛错，交给调用方处理", async () => {
  const failed = new Error("读写出错");
  const { store } = harness({ wrap: (inner) => ({ ...inner, write: () => Promise.reject(failed) }) });

  await assert.rejects(() => store.update(KEY, () => ({ transcript: [] })), failed);
});

test("等网络的工夫清除过缓存：回来的写入不写回，也不删清除之后的内容", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard });
  const since = guard.epoch();
  await guard.clear("cache", () => {});

  assert.equal(await store.save(KEY, { transcript: ["清除前读到的"] }, { since }), false);
  assert.equal(await store.update(KEY, () => ({ transcript: ["清除前读到的"] }), { since }), null);
  assert.deepEqual(await keysIn(driver), []);

  await store.save(KEY, { transcript: ["清除后读到的"] });
  await store.remove(KEY, { since });
  assert.deepEqual((await store.load(KEY))?.transcript, ["清除后读到的"], "清除前登记的删除不再执行");
});

test("清除全部数据同样挡住缓存写入", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard });
  const since = guard.epoch();
  await guard.clear("all", () => {});

  assert.equal(await store.save(KEY, { transcript: [] }, { since }), false);
  assert.deepEqual(await keysIn(driver), []);
});

test("排在写队列里时清除了缓存：调用方没记代数也不写回", async () => {
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

  const first = store.save(part(1), { transcript: [] });
  await writing.promise;
  const queued = store.save(part(2), { transcript: [] });
  const clearing = guard.clear("cache", () => driver.clear());
  holding.resolve();

  assert.deepEqual(await Promise.all([first, queued]), [true, false]);
  await clearing;
  assert.deepEqual(await keysIn(driver), []);
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

  const saving = store.save(KEY, { transcript: [] });
  await writing.promise;
  const clearing = guard.clear("cache", async () => {
    await driver.clear();
    order.push("clear");
  });
  await nextTurn();
  assert.deepEqual(order, [], "清除在等正在写的那一下");
  holding.resolve();
  await Promise.all([saving, clearing]);

  assert.deepEqual(order, ["write", "clear"]);
  assert.deepEqual(await keysIn(driver), [], "写完的那份随后被清掉，不会留到清除之后");
});

test("清除进行中才开始的写入等清完再写，读—改—写读到的是清完的数据", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard, seed: [entry(1, 0)] });
  const holding = deferred();
  const running = deferred();
  const clearing = guard.clear("cache", async () => {
    running.resolve();
    await holding.promise;
    await driver.clear();
  });
  await running.promise;

  const saving = store.save(part(2), { transcript: ["清除后的新操作"] });
  const seen: (Entry | null)[] = [];
  const updating = store.update(part(1), (current) => {
    seen.push(current);
    return null;
  });
  holding.resolve();
  await Promise.all([clearing, saving, updating]);

  assert.deepEqual(await keysIn(driver), [part(2)]);
  assert.deepEqual(seen, [null], "清除之前的旧条目读不到，也写不回去");
});
