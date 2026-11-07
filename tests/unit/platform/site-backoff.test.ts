// 站点限速和退避：时钟和等待都由测试控制，不真等。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSiteBackoff, type SiteBackoffHandle } from "../../../src/platform/site-backoff.ts";
import { clearTargets } from "../../../src/shared/storage-plan.ts";
import { memoryStorage, type MemoryStorage } from "../../helpers/memory-storage.ts";

const KEY = "jianmu_site_backoff";
const NEVER = new AbortController().signal;

function world(session: MemoryStorage = memoryStorage()) {
  const clock = { at: 1_000_000 };
  const waits: number[] = [];
  const make = (site: "bilibili" | "youtube" = "bilibili"): SiteBackoffHandle =>
    createSiteBackoff({
      site,
      session,
      now: () => clock.at,
      sleep: async (ms, signal) => {
        signal.throwIfAborted();
        waits.push(ms);
        clock.at += ms;
      },
    });
  return { clock, waits, session, make };
}

test("平时放行，桶里的令牌用完才排队，每 1.5 秒补一个", async () => {
  const { clock, waits, make } = world();
  const backoff = make();

  for (let index = 0; index < 8; index += 1) assert.deepEqual(await backoff.admit(NEVER), { ok: true });
  assert.deepEqual(waits, []);

  assert.deepEqual(await backoff.admit(NEVER), { ok: true });
  assert.deepEqual(waits, [1500]);

  clock.at += 15_000;
  waits.length = 0;
  for (let index = 0; index < 8; index += 1) await backoff.admit(NEVER);
  assert.deepEqual(waits, [], "空闲够久，桶满了，但不超过容量");
  await backoff.admit(NEVER);
  assert.deepEqual(waits, [1500]);
});

test("排队的按先后等，后面的等得更久", async () => {
  const session = memoryStorage();
  const clock = { at: 1000 };
  const seen: number[] = [];
  const backoff = createSiteBackoff({
    site: "bilibili",
    session,
    now: () => clock.at,
    sleep: async (ms) => {
      seen.push(ms);
    },
  });
  await Promise.all(Array.from({ length: 10 }, () => backoff.admit(NEVER)));
  assert.deepEqual(seen, [1500, 3000]);
});

test("排队时取消：不发，令牌还回去", async () => {
  const session = memoryStorage();
  const controller = new AbortController();
  const waits: number[] = [];
  const backoff = createSiteBackoff({
    site: "bilibili",
    session,
    now: () => 1000,
    sleep: async (ms, signal) => {
      waits.push(ms);
      controller.abort(new Error("取消"));
      signal.throwIfAborted();
    },
  });
  for (let index = 0; index < 8; index += 1) await backoff.admit(NEVER);

  await assert.rejects(backoff.admit(controller.signal), /取消/);
  await assert.rejects(backoff.admit(controller.signal), /取消/, "已经取消的不排队");

  assert.deepEqual(await backoff.admit(NEVER), { ok: true });
  assert.deepEqual(waits, [1500, 1500]);
});

test("排队的时候进了退避：等完也不放行", async () => {
  const backoff = createSiteBackoff({
    site: "bilibili",
    session: memoryStorage(),
    now: () => 1000,
    sleep: async () => {
      await backoff.trip();
    },
  });
  for (let index = 0; index < 8; index += 1) await backoff.admit(NEVER);
  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 60 });
});

test("第一次退避 60 秒，退避期内不放行，也不排队", async () => {
  const { clock, waits, make } = world();
  const backoff = make();

  await backoff.trip();

  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 60 });
  clock.at += 59_500;
  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 1 });
  assert.deepEqual(waits, []);
  clock.at += 500;
  assert.deepEqual(await backoff.admit(NEVER), { ok: true }, "到期放行下一次操作");
});

test("连续命中翻倍，上限 1 小时", async () => {
  const { clock, make } = world();
  const backoff = make();
  const seconds: number[] = [];
  for (let strike = 0; strike < 9; strike += 1) {
    await backoff.trip();
    const blocked = await backoff.admit(NEVER);
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    seconds.push(blocked.retryAfterSec);
    clock.at += blocked.retryAfterSec * 1000;
  }
  assert.deepEqual(seconds, [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
});

test("退避期内再次命中不累加", async () => {
  const { clock, make, session } = world();
  const backoff = make();

  await backoff.trip();
  clock.at += 10_000;
  await backoff.trip();
  await backoff.trip();

  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 50 });
  assert.deepEqual(session.data[KEY], { bilibili: { strikes: 1, until: 1_060_000 } });
});

test("Retry-After 更长时听它，更短时按退避", async () => {
  const { clock, make } = world();
  const backoff = make();

  await backoff.trip(300);
  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 300 });

  clock.at += 300_000;
  await backoff.trip(5);
  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 120 });
});

test("退避期内再收到更长的 Retry-After：延后到期时间，不算一次新的命中", async () => {
  const { make, session } = world();
  const backoff = make();

  await backoff.trip();
  await backoff.trip(600);

  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 600 });
  assert.deepEqual(session.data[KEY], { bilibili: { strikes: 1, until: 1_600_000 } });
});

test("service worker 重启以后退避还在，连续命中也接着算", async () => {
  const { clock, make, session } = world();
  await make().trip();

  const restarted = make();
  assert.deepEqual(await restarted.admit(NEVER), { ok: false, retryAfterSec: 60 });

  clock.at += 60_000;
  await make().trip();
  assert.deepEqual(session.data[KEY], { bilibili: { strikes: 2, until: 1_180_000 } });
});

test("读取成功清掉连击，下一次退避从 60 秒算起", async () => {
  const { clock, make, session } = world();
  const backoff = make();
  await backoff.trip();
  clock.at += 60_000;

  await backoff.clear();

  assert.deepEqual(session.data[KEY], {});
  await backoff.trip();
  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 60 });
});

test("退避期内回来的成功不解除退避", async () => {
  const { make } = world();
  const backoff = make();
  await backoff.trip();

  await backoff.clear();

  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 60 });
});

test("平时读取成功不写存储", async () => {
  const session = memoryStorage();
  const backoff = world(session).make();

  await backoff.clear();

  assert.deepEqual(session.data, {});
});

test("清除全部数据后退避仍生效", async () => {
  const { make, session } = world();
  const backoff = make();
  await backoff.trip();

  await session.remove(clearTargets("all").session);

  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 60 });
  assert.deepEqual(await make().admit(NEVER), { ok: false, retryAfterSec: 60 }, "重启后也还在");
});

test("两个站各算各的，同时写也不互相盖掉", async () => {
  const { make, session } = world();
  const bilibili = make("bilibili");
  const youtube = make("youtube");

  await Promise.all([bilibili.trip(), youtube.trip(120)]);

  assert.deepEqual(session.data[KEY], {
    bilibili: { strikes: 1, until: 1_060_000 },
    youtube: { strikes: 1, until: 1_120_000 },
  });
  await bilibili.clear();
  assert.equal((await youtube.admit(NEVER)).ok, false);
});

test("写不进存储时这次退避照样生效", async () => {
  const session = memoryStorage();
  const broken = { ...session, set: async () => Promise.reject(new Error("存储坏了")) };
  const backoff = createSiteBackoff({ site: "bilibili", session: broken, now: () => 1000 });

  await assert.rejects(backoff.trip(), /存储坏了/);

  assert.deepEqual(await backoff.admit(NEVER), { ok: false, retryAfterSec: 60 });
});

test("存储里的记录形状不对时当没有", async () => {
  const session = memoryStorage({ [KEY]: { bilibili: { until: "soon" } } });
  assert.deepEqual(await world(session).make().admit(NEVER), { ok: true });
});
