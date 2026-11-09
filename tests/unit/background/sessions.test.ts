// 观看会话：按标签页记，刷新同一视频沿用、换视频开新的；时长和频道每个视频只认第一条；
// 播放进度只增不减、不超过真实经过的时间；满 1 分钟按规则切模式，变了才广播；主动切换记频道，撤销不记。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessions, PLAYED_SLACK_SEC, type WatchSession } from "../../../src/background/sessions.ts";
import { createChannelStore, type ChannelRecord } from "../../../src/background/stores/channels.ts";
import { createClearGuard, type ClearGuard } from "../../../src/core/clear-guard.ts";
import { channelKey, videoKey, type VideoKey } from "../../../src/core/video-ref.ts";
import { WATCH_SESSIONS_KEY } from "../../../src/shared/names.ts";
import { SAMPLE_VIDEO_ID } from "../../helpers/chrome.ts";
import { createMemoryDriver } from "../../helpers/memory-driver.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";
import { until } from "../../helpers/wait-until.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID });
const NEXT = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID, segment: 2 });
const CHANNEL_REF = { platform: "bilibili", channelId: "4242" } as const;
const CHANNEL = channelKey(CHANNEL_REF);
const LONG = 20 * 60;
const TAB = 31;

function harness({ channels = [] as ChannelRecord[], guard = createClearGuard() as ClearGuard, stored = {} as Record<string, unknown> } = {}) {
  let clock = 1_000_000;
  const memory = memoryStorage(stored);
  const counts = { writes: 0 };
  const storage = {
    ...memory,
    async set(entries: Record<string, unknown>) {
      counts.writes += 1;
      await memory.set(entries);
    },
  };
  const memoryDriver = createMemoryDriver<ChannelRecord>("channels", channels);
  // 测试可以换掉读频道偏好这一步：让它出错，或者停在那里等测试放行。
  const hooks: { get: (key: string) => Promise<ChannelRecord | undefined> } = { get: (key) => memoryDriver.get(key) };
  const driver = { ...memoryDriver, get: (key: string | number) => hooks.get(String(key)) };
  const channelStore = createChannelStore({ driver, guard, now: () => clock });
  const broadcasts: unknown[] = [];
  const logged: string[] = [];
  const sessions = createSessions({
    storage,
    channels: channelStore,
    guard,
    now: () => clock,
    broadcast: (message) => void broadcasts.push(message),
    log: { warn: (message: string) => void logged.push(message), error: (message: string) => void logged.push(message) },
  });
  const table = () => (memory.data[WATCH_SESSIONS_KEY] ?? {}) as Record<string, WatchSession>;
  return {
    sessions,
    storage,
    counts,
    hooks,
    driver: memoryDriver,
    broadcasts,
    logged,
    table,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

// 按真实时间播放：每 10 秒报一次累计秒数。
async function play(world: ReturnType<typeof harness>, video: VideoKey, untilSec: number, from = 0) {
  let last: Awaited<ReturnType<typeof world.sessions.onMilestone>> | undefined;
  for (let played = from + 10; played <= untilSec; played += 10) {
    world.advance(10);
    last = await world.sessions.onMilestone(TAB, video, played);
  }
  return last;
}

test("第一次报时长和频道开会话：长视频进速览，回从 0 开始计、接着报", async () => {
  const world = harness();
  assert.deepEqual(await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG, channel: CHANNEL_REF }), {
    ok: true,
    value: { playedSec: 0, report: true },
  });
  assert.deepEqual(await world.sessions.get(TAB), { video: VIDEO, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0 });
  assert.equal(world.table()[String(TAB)]?.channel, CHANNEL);
  assert.equal(world.broadcasts.length, 1);
});

test("短视频进精读；频道选过的按频道", async () => {
  const short = harness();
  await short.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: 120 });
  assert.equal((await short.sessions.get(TAB))?.modeSource, "short");

  const remembered = harness({ channels: [{ channelKey: CHANNEL, mode: "study", updatedAt: 1 }] });
  await remembered.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG, channel: CHANNEL_REF });
  assert.deepEqual(await remembered.sessions.get(TAB), { video: VIDEO, mode: "study", modeSource: "channel", autoSwitched: false, playedSec: 0 });
});

test("刷新同一个视频沿用原会话：模式、来源、自动切过、累计秒数和开始时间都留着，回会话里的累计秒数", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  await play(world, VIDEO, 70);
  const before = world.table()[String(TAB)];
  assert.equal(before?.autoSwitched, true);

  world.advance(5);
  const again = await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: 30, channel: CHANNEL_REF });
  assert.deepEqual(again, { ok: true, value: { playedSec: 70, report: false } });
  assert.deepEqual(world.table()[String(TAB)], before, "同一视频的第二条时长和频道不认");
});

test("换了视频开新会话：之前的模式、累计秒数和卡片的手动展开收起都不带过去", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  await world.sessions.setCardOverride(TAB, VIDEO, "collapsed");
  await play(world, VIDEO, 70);

  const next = await world.sessions.onPlaybackInfo(TAB, NEXT, { durationSec: LONG });
  assert.deepEqual(next, { ok: true, value: { playedSec: 0, report: true } });
  assert.deepEqual(await world.sessions.get(TAB), { video: NEXT, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0 });
});

test("播满 1 分钟切到精读：只在模式变了时广播，切过以后回复里叫内容脚本停报", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  world.broadcasts.length = 0;

  assert.deepEqual(await play(world, VIDEO, 50), { ok: true, value: { report: true } });
  assert.deepEqual(world.broadcasts, [], "累计秒数变了不广播");
  assert.equal(world.table()[String(TAB)]?.playedSec, 50, "累计秒数照样写进会话");

  assert.deepEqual(await play(world, VIDEO, 60, 50), { ok: true, value: { report: false } });
  assert.deepEqual(world.broadcasts, [
    { type: "session.changed", tabId: TAB, session: { video: VIDEO, mode: "study", modeSource: "auto", autoSwitched: true, playedSec: 60 } },
  ]);
});

test("撤销自动切换回到速览、不记频道，这次观看不再切；之后主动选精读才记住频道", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG, channel: CHANNEL_REF });
  await play(world, VIDEO, 60);

  const undone = await world.sessions.setMode(TAB, VIDEO, { intent: "undo-auto" });
  assert.deepEqual(undone, { ok: true, value: { video: VIDEO, mode: "skim", modeSource: "default", autoSwitched: true, playedSec: 60 } });
  assert.deepEqual(await world.driver.getAll(), [], "撤销不记频道");

  await play(world, VIDEO, 200, 60);
  assert.equal((await world.sessions.get(TAB))?.mode, "skim", "这次观看不再自动切");

  const manual = await world.sessions.setMode(TAB, VIDEO, { intent: "manual", mode: "study" });
  assert.equal(manual.ok && manual.value.modeSource, "manual");
  assert.deepEqual(
    (await world.driver.getAll()).map(({ channelKey: key, mode }) => ({ key, mode })),
    [{ key: CHANNEL, mode: "study" }],
  );
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 200), { ok: true, value: { report: false } }, "手动选过就停报");
});

test("频道还不知道时主动选模式：不记频道；之后报上来的频道也不补记，这次选的模式不变", async () => {
  const early = harness({ channels: [{ channelKey: CHANNEL, mode: "skim", updatedAt: 1 }] });
  // 播放上报还没到，侧边栏里先选了精读。
  const picked = await early.sessions.setMode(TAB, VIDEO, { intent: "manual", mode: "study" });
  assert.equal(picked.ok && picked.value.modeSource, "manual");
  await early.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG, channel: CHANNEL_REF });
  assert.deepEqual(await early.sessions.get(TAB), { video: VIDEO, mode: "study", modeSource: "manual", autoSwitched: false, playedSec: 0 }, "频道偏好不盖掉这次选的");
  assert.deepEqual(
    (await early.driver.getAll()).map(({ channelKey: key, mode }) => ({ key, mode })),
    [{ key: CHANNEL, mode: "skim" }],
    "频道偏好还是原来那条，没有按这次选的补记",
  );

  const unknown = harness();
  await unknown.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  assert.equal((await unknown.sessions.setMode(TAB, VIDEO, { intent: "manual", mode: "study" })).ok, true);
  assert.deepEqual(await unknown.driver.getAll(), [], "这个视频没报频道：主动选了也没有可记的");
});

test("这次手动选过模式：播多久都不自动切；没有切过可撤销的时候撤销什么都不改", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  await world.sessions.setMode(TAB, VIDEO, { intent: "manual", mode: "skim" });
  await play(world, VIDEO, 120);
  assert.deepEqual(await world.sessions.get(TAB), { video: VIDEO, mode: "skim", modeSource: "manual", autoSwitched: false, playedSec: 120 });

  const stored = world.table()[String(TAB)];
  assert.equal((await world.sessions.setMode(TAB, VIDEO, { intent: "undo-auto" })).ok, true);
  assert.deepEqual(world.table()[String(TAB)], stored);
});

test("累计秒数只增不减，不超过会话开始以来真实经过的时间加 2 秒；不认的那条什么都不改", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  world.advance(10);
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 10 + PLAYED_SLACK_SEC + 1), { ok: false, code: "INVALID_REQUEST" });
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 10 + PLAYED_SLACK_SEC), { ok: true, value: { report: true } });
  world.advance(100);
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 5), { ok: false, code: "INVALID_REQUEST" }, "比已记下的少");
  assert.equal(world.table()[String(TAB)]?.playedSec, 10 + PLAYED_SLACK_SEC);
});

test("一下子报出超过真实时间的累计秒数，不能直接跳到自动切换", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  world.advance(10);
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 600), { ok: false, code: "INVALID_REQUEST" });
  assert.equal((await world.sessions.get(TAB))?.mode, "skim");
});

test("没报过这个视频的时长和频道就报进度：说明还没有这次观看的记录", async () => {
  const world = harness();
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 10), { ok: false, code: "SESSION_NOT_FOUND" });
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  world.advance(10);
  assert.deepEqual(await world.sessions.onMilestone(TAB, NEXT, 10), { ok: false, code: "SESSION_NOT_FOUND" });
});

test("侧边栏和卡片拿着旧视频来改：标签页里已经换了视频，不改新视频的会话", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, NEXT, { durationSec: LONG });
  const stored = world.table()[String(TAB)];
  assert.deepEqual(await world.sessions.setMode(TAB, VIDEO, { intent: "manual", mode: "study" }), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(await world.sessions.setCardOverride(TAB, VIDEO, "expanded"), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(world.table()[String(TAB)], stored);
  assert.deepEqual(await world.driver.getAll(), []);
});

test("卡片手动展开收起记进会话；还没报过时长时先开会话，之后那一条时长和频道照样补上", async () => {
  const world = harness();
  const collapsed = await world.sessions.setCardOverride(TAB, VIDEO, "collapsed");
  assert.equal(collapsed.ok && collapsed.value.cardOverride, "collapsed");

  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: 120 });
  assert.deepEqual(await world.sessions.get(TAB), {
    video: VIDEO,
    mode: "study",
    modeSource: "short",
    autoSwitched: false,
    playedSec: 0,
    cardOverride: "collapsed",
  });
});

test("关掉标签页删掉它的会话，别的标签页不动；没有会话的标签页关掉不写存储", async () => {
  const world = harness();
  await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG });
  await world.sessions.onPlaybackInfo(TAB + 1, NEXT, { durationSec: LONG });
  await world.sessions.onTabRemoved(TAB);
  assert.deepEqual(Object.keys(world.table()), [String(TAB + 1)]);

  const writes = world.counts.writes;
  await world.sessions.onTabRemoved(99);
  assert.equal(world.counts.writes, writes);
});

test("存储里形状不对的会话整条不认", async () => {
  const world = harness({
    stored: {
      [WATCH_SESSIONS_KEY]: {
        [String(TAB)]: { video: VIDEO, mode: "english", modeSource: "default" },
        "not-a-tab": { video: VIDEO },
      },
    },
  });
  assert.equal(await world.sessions.get(TAB), null);
  assert.deepEqual(await world.sessions.onMilestone(TAB, VIDEO, 0), { ok: false, code: "SESSION_NOT_FOUND" });
});

test("读频道偏好失败：按没选过开会话，记一条日志", async () => {
  const world = harness();
  world.hooks.get = async () => {
    throw new Error("database closed");
  };
  assert.equal((await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG, channel: CHANNEL_REF })).ok, true);
  assert.equal((await world.sessions.get(TAB))?.modeSource, "default");
  assert.equal(world.logged.length, 1);
});

test("清除全部数据之前开始、清除之后才轮到写的会话改动不写回，回还没启用；清除之后开始的照常写", async () => {
  const guard = createClearGuard();
  const world = harness({ guard });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = world.hooks.get;
  let reading = false;
  world.hooks.get = async (key) => {
    reading = true;
    await held;
    return get(key);
  };
  // 第一次写停在读频道偏好上，第二次排在它后面；这时清除全部数据。
  const first = world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG, channel: CHANNEL_REF });
  const second = world.sessions.setCardOverride(TAB + 1, NEXT, "expanded");
  assert.ok(await until(() => reading));
  const clearing = guard.clear("all", () => world.storage.remove(WATCH_SESSIONS_KEY));
  release();
  await clearing;

  assert.equal((await first).ok, true, "已经在写的那次先写完，再被清掉");
  assert.deepEqual(await second, { ok: false, code: "NOT_ENABLED" });
  assert.deepEqual(world.table(), {});

  assert.equal((await world.sessions.onPlaybackInfo(TAB, VIDEO, { durationSec: LONG })).ok, true);
  assert.deepEqual(Object.keys(world.table()), [String(TAB)]);
});
