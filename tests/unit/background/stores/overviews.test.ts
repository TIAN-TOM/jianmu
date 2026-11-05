import assert from "node:assert/strict";
import { test } from "node:test";
import { createOverviewStore } from "../../../../src/background/stores/overviews.ts";
import { createClearGuard, NO_CLEAR_GUARD, type ClearGuard } from "../../../../src/core/clear-guard.ts";
import type { LearningAnalysis } from "../../../../src/core/notes/markdown.ts";
import { OVERVIEW_RECORD_VERSION, type OverviewRecord } from "../../../../src/core/notes/records.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import type { IdbKey, ObjectStoreDriver } from "../../../../src/platform/idb.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

const VIDEO_ID = "BV1Sample000";
const part = (segment: number): VideoKey => videoKey({ platform: "bilibili", videoId: VIDEO_ID, segment });
const KEY = part(1);
const OTHER = videoKey({ platform: "bilibili", videoId: "BV2Sample000" });

const analysisTitled = (title: string): LearningAnalysis => ({
  chapters: [{ title, timestampSeconds: 0 }],
  keyQuotes: [],
});

function overview(key: VideoKey, updatedAt = 1000, title = `章节 ${key}`): OverviewRecord {
  return {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey: key,
    snapshot: { title: "番茄种植课", author: "老园丁" },
    analysis: analysisTitled(title),
    updatedAt,
  };
}

const chapterTitle = (record: OverviewRecord | null | undefined): unknown => record?.analysis.chapters?.[0]?.title;

interface HarnessOptions {
  readonly guard?: ClearGuard;
  readonly seed?: readonly OverviewRecord[];
  readonly wrap?: (inner: ObjectStoreDriver<OverviewRecord>) => ObjectStoreDriver<OverviewRecord>;
}

function harness({ guard = NO_CLEAR_GUARD, seed = [], wrap = (inner) => inner }: HarnessOptions = {}) {
  const clock = { now: 0 };
  const driver = createMemoryDriver<OverviewRecord>("overviews", seed);
  return { clock, driver, store: createOverviewStore({ driver: wrap(driver), guard, now: () => clock.now }) };
}

test("概览学习记录按视频键长期保存，互不覆盖", async () => {
  const { clock, store } = harness();
  const analysis = analysisTitled("第一章");
  clock.now = 3000;

  await store.save({ videoKey: part(2), title: "视频标题", author: "UP 主", analysis });

  assert.equal(await store.find(part(1)), null);
  assert.deepEqual(await store.find(part(2)), {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey: part(2),
    snapshot: { title: "视频标题", author: "UP 主" },
    analysis,
    updatedAt: 3000,
  });
});

test("概览失败区间会跟着学习记录保存，成功后清掉", async () => {
  const { store } = harness();
  const analysis = analysisTitled("前半");
  const failures = [{ index: 1, startSeconds: 600, endSeconds: 1170 }];

  const saved = await store.save({ videoKey: KEY, analysis, analysisFailures: failures });
  assert.deepEqual(saved?.analysisFailures, failures);

  const cleared = await store.save({ videoKey: KEY, analysis, analysisFailures: [] });
  assert.equal(cleared?.analysisFailures, undefined);
  assert.equal((await store.find(KEY))?.analysisFailures, undefined);
});

test("概览仓储以 videoKey 为主键存取", async () => {
  const { store } = harness();

  await store.put(overview(part(1)));
  await store.put(overview(part(2)));

  assert.equal((await store.all()).length, 2);
  assert.equal(chapterTitle(await store.find(part(2))), `章节 ${part(2)}`);
  assert.equal(await store.find(OTHER), null);
  await assert.rejects(() => store.put({ noKey: true } as unknown as OverviewRecord), /videoKey/);
});

test("长期存储保留失败原因，超长的截到 200 字", async () => {
  const { store } = harness();

  const saved = await store.save({
    videoKey: KEY,
    analysis: analysisTitled("前半"),
    analysisFailures: [
      { index: 1, startSeconds: 600, endSeconds: 1170, reason: "  服务限流了，稍等一会儿再试。 " },
      { index: 2, startSeconds: 1170, endSeconds: 1800, reason: "长".repeat(260) },
      { index: 3, startSeconds: 1800, endSeconds: 2400, reason: 42 },
    ],
  });

  assert.equal(saved?.analysisFailures?.[0]?.reason, "服务限流了，稍等一会儿再试。");
  assert.equal(saved?.analysisFailures?.[1]?.reason?.length, 200);
  assert.equal("reason" in (saved?.analysisFailures?.[2] ?? {}), false, "不是字符串的原因不保存");
  assert.equal((await store.find(KEY))?.analysisFailures?.[0]?.reason, "服务限流了，稍等一会儿再试。");
});

// 读出全部记录后先停住，由测试决定什么时候把结果交回去：
// 「读完快照、还没写回」的空档正是旧快照覆盖新记录的地方。
test("仓储的读—改—写在写队列里一次做完，别的写入插不进读和写之间", async () => {
  const held = deferred();
  const { store } = harness({
    wrap: (inner) => ({
      ...inner,
      async getAll() {
        const rows = await inner.getAll();
        await held.promise;
        return rows;
      },
    }),
  });
  await store.put(overview(KEY, 100, "旧"));

  const updating = store.update((current) => ({ put: current.map((row) => ({ ...row, updatedAt: 150 })) }));
  const saving = store.put(overview(KEY, 200, "新"));
  held.resolve();
  await Promise.all([updating, saving]);

  assert.equal(chapterTitle(await store.find(KEY)), "新", "后到的写入排在读改写之后，不被旧快照盖掉");
});

test("只补缺的保存不碰已有记录，没有时才写入", async () => {
  const { clock, store } = harness();
  const input = { videoKey: KEY, analysis: analysisTitled("缓存里的旧概览") };

  clock.now = 1;
  const first = await store.save(input, { onlyIfMissing: true });
  assert.equal(chapterTitle(first), "缓存里的旧概览");

  clock.now = 2;
  await store.save({ videoKey: KEY, analysis: analysisTitled("新生成") });
  clock.now = 3;
  assert.equal(await store.save(input, { onlyIfMissing: true }), null);
  assert.equal(chapterTitle(await store.find(KEY)), "新生成");
});

test("按 id 的读—改—写只读那一条：拿到去掉存储主键的记录，没有时是 null", async () => {
  const reads: { getAll: number; get: IdbKey[] } = { getAll: 0, get: [] };
  const { store } = harness({
    seed: [overview(OTHER, 1)],
    wrap: (inner) => ({
      ...inner,
      async getAll() {
        reads.getAll += 1;
        return inner.getAll();
      },
      async get(key) {
        reads.get.push(key);
        return inner.get(key);
      },
    }),
  });

  const seen: (OverviewRecord | null)[] = [];
  const missing = await store.updateRecord(KEY, (current) => {
    seen.push(current);
    return { put: [overview(KEY, 2)], result: "写了" };
  });
  assert.equal(missing, "写了");
  const present = await store.updateRecord(KEY, (current) => {
    seen.push(current);
    return { result: current?.updatedAt };
  });
  assert.equal(present, 2);

  assert.deepEqual(seen, [null, overview(KEY, 2)], "记录上只有视频键，没有另外的存储主键");
  assert.equal(reads.getAll, 0);
  assert.deepEqual(reads.get, [KEY, KEY]);
  assert.equal((await store.all()).length, 2, "别的记录不受影响");
});

test("按 id 的读—改—写同样排在写队列里，读和写之间插不进别的写入", async () => {
  const held = deferred();
  const { clock, store } = harness({
    wrap: (inner) => ({
      ...inner,
      async get(key) {
        const row = await inner.get(key);
        await held.promise;
        return row;
      },
    }),
  });
  clock.now = 1;

  const backfill = store.save({ videoKey: KEY, analysis: analysisTitled("缓存里的旧概览") }, { onlyIfMissing: true });
  const generated = store.save({ videoKey: KEY, analysis: analysisTitled("新生成") });
  held.resolve();
  await Promise.all([backfill, generated]);

  assert.equal(chapterTitle(await store.find(KEY)), "新生成", "后到的写入排在补存之后，没被盖掉");
});

test("读—改—写排在前一次写入之后才读：不拿写入之前的快照盖掉", async () => {
  const holding = deferred();
  const writing = deferred();
  const { store } = harness({
    seed: [overview(KEY, 100, "旧")],
    wrap: (inner) => ({
      ...inner,
      async write(change) {
        writing.resolve();
        await holding.promise;
        await inner.write(change);
      },
    }),
  });

  const saving = store.put(overview(KEY, 200, "新"));
  await writing.promise;
  const seen: unknown[] = [];
  const updating = store.update((current) => {
    seen.push(chapterTitle(current[0]));
    return {};
  });
  const updatingOne = store.updateRecord(KEY, (current) => {
    seen.push(chapterTitle(current));
    return {};
  });
  holding.resolve();
  await Promise.all([saving, updating, updatingOne]);

  assert.deepEqual(seen, ["新", "新"]);
});

test("标题和作者按上限截断，缺的写成空串", async () => {
  const { store } = harness();

  const long = await store.save({
    videoKey: KEY,
    title: "题".repeat(600),
    author: "作".repeat(400),
    analysis: analysisTitled("一"),
  });
  assert.equal(long?.snapshot.title.length, 500);
  assert.equal(long?.snapshot.author.length, 300);

  const bare = await store.save({ videoKey: OTHER, analysis: analysisTitled("二") });
  assert.deepEqual(bare?.snapshot, { title: "", author: "" });
});

test("视频键不对的概览不进库", async () => {
  const { driver, store } = harness();
  const broken = "认不出" as VideoKey;

  await assert.rejects(() => store.save({ videoKey: broken, analysis: analysisTitled("一") }), /videoKey/);
  await assert.rejects(
    () => store.save({ videoKey: broken, analysis: analysisTitled("一") }, { onlyIfMissing: true }),
    /videoKey/,
  );
  await assert.rejects(() => store.updateAnalysis({ videoKey: broken }, () => analysisTitled("一")), /videoKey/);
  await store.update(() => ({ put: [{ ...overview(KEY), videoKey: broken }, overview(OTHER)] }));

  assert.deepEqual(
    (await driver.getAll()).map((row) => row.videoKey),
    [OTHER],
    "一批里的坏记录逐条跳过",
  );
});

test("只改概览：基于现读的记录写回，其余字段照旧，更新时间换新", async () => {
  const failures = [{ index: 1, startSeconds: 60, endSeconds: 120 }];
  const { clock, store } = harness({ seed: [{ ...overview(KEY, 100, "导入的"), analysisFailures: failures }] });
  clock.now = 200;

  const seen: (LearningAnalysis | null)[] = [];
  const record = await store.updateAnalysis(
    { videoKey: KEY, title: "不该用上的标题", analysisFailures: [] },
    (current) => {
      seen.push(current);
      return { ...current, verdict: { summary: "一句话结论" } };
    },
  );

  assert.deepEqual(seen, [analysisTitled("导入的")]);
  assert.equal(record?.updatedAt, 200);
  assert.deepEqual(record?.analysisFailures, failures);
  assert.equal(record?.snapshot.title, "番茄种植课");
  assert.deepEqual(await store.find(KEY), record);
  assert.equal(chapterTitle(record), "导入的");
});

test("只改概览：交回空值或原样交回不写，返回现有记录", async () => {
  const seeded = overview(KEY, 100);
  const { clock, driver, store } = harness({ seed: [seeded] });
  clock.now = 200;

  assert.deepEqual(await store.updateAnalysis({ videoKey: KEY }, (current) => current), seeded);
  assert.deepEqual(await store.updateAnalysis({ videoKey: KEY }, () => null), seeded);
  assert.equal(await store.updateAnalysis({ videoKey: OTHER }, () => null), null);
  assert.deepEqual(await driver.getAll(), [seeded], "更新时间没变，也没有多出记录");
});

test("只改概览：还没有这条记录时用传进来的标题和失败区间新建", async () => {
  const { clock, store } = harness();
  clock.now = 5;
  const failures = [{ index: 2, startSeconds: 30, endSeconds: 60 }];

  const record = await store.updateAnalysis(
    { videoKey: KEY, title: "视频标题", author: "UP 主", analysisFailures: failures },
    (current) => {
      assert.equal(current, null);
      return analysisTitled("新结论");
    },
  );

  assert.deepEqual(record, {
    schemaVersion: OVERVIEW_RECORD_VERSION,
    videoKey: KEY,
    snapshot: { title: "视频标题", author: "UP 主" },
    analysis: analysisTitled("新结论"),
    updatedAt: 5,
    analysisFailures: failures,
  });
});

test("等模型的工夫清除了全部数据：每条写入路径都不写回", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard });
  const since = guard.epoch();
  await guard.clear("all", () => {});
  const input = { videoKey: KEY, analysis: analysisTitled("晚到的") };
  let planned = 0;
  const plan = (): { put: OverviewRecord[]; result: string } => {
    planned += 1;
    return { put: [overview(KEY)], result: "写了" };
  };

  assert.equal(await store.put(overview(KEY), { since }), false);
  assert.equal(await store.save(input, { since }), null);
  assert.equal(await store.save(input, { since, onlyIfMissing: true }), null);
  assert.equal(await store.update(plan, { since }), null);
  assert.equal(await store.updateRecord(KEY, plan, { since }), null);
  assert.equal(
    await store.updateAnalysis(
      input,
      () => {
        planned += 1;
        return analysisTitled("晚到的");
      },
      { since },
    ),
    null,
  );

  assert.equal(planned, 0, "清除过就不调用 plan");
  assert.deepEqual(await driver.getAll(), []);
});

test("只清除了缓存：概览照常写", async () => {
  const guard = createClearGuard();
  const { store } = harness({ guard });
  const since = guard.epoch();
  await guard.clear("cache", () => {});

  assert.ok(await store.save({ videoKey: KEY, analysis: analysisTitled("留下") }, { since }));
  assert.equal(await store.update(() => ({ result: "跑了" }), { since }), "跑了");
});

test("排在写队列里时清除了全部数据：调用方没记代数也不重建", async () => {
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

  const first = store.save({ videoKey: KEY, analysis: analysisTitled("先写的") });
  await writing.promise;
  const queued = store.save({ videoKey: OTHER, analysis: analysisTitled("排队的") });
  const clearing = guard.clear("all", () => driver.clear());
  holding.resolve();

  assert.equal(chapterTitle(await first), "先写的");
  assert.equal(await queued, null);
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

  const saving = store.put(overview(KEY));
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
  assert.equal(await store.find(KEY), null, "写完的那份随后被清掉，不会留到清除之后");
});

test("清除进行中才开始的写入等清完再写，读—改—写读到的是清完的数据", async () => {
  const guard = createClearGuard();
  const { driver, store } = harness({ guard, seed: [overview(KEY)] });
  const holding = deferred();
  const running = deferred();
  const clearing = guard.clear("all", async () => {
    running.resolve();
    await holding.promise;
    await driver.clear();
  });
  await running.promise;

  const seen: (LearningAnalysis | null)[] = [];
  const updating = store.updateAnalysis({ videoKey: KEY }, (current) => {
    seen.push(current);
    return analysisTitled("清除后的新操作");
  });
  holding.resolve();
  await Promise.all([clearing, updating]);

  assert.deepEqual(seen, [null], "清除之前的概览读不到，也写不回去");
  assert.equal(chapterTitle(await store.find(KEY)), "清除后的新操作");
});
