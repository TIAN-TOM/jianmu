// 侧边栏的播放器指令：换了视频后第一次问没连上时，页面可能还在加载，隔一会儿再问几次；连上了就不再追问，换了视频旧的重问作废。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoKey } from "../../../../src/core/video-ref.ts";
import { createPlayer, RECONNECT_MS } from "../../../../src/pages/sidepanel/player.ts";
import { until } from "../../../helpers/wait-until.ts";

const VIDEO = "youtube:jmSample0001" as VideoKey;
const OTHER = "youtube:jmSample0002" as VideoKey;

function setup(connectAfter: number) {
  let asks = 0;
  const pending: { run: () => void; ms: number }[] = [];
  const player = createPlayer({
    tabs: {
      async sendMessage() {
        asks += 1;
        if (asks <= connectAfter) throw new Error("Could not establish connection");
        return { ok: true, value: { status: "paused", atSec: 3, durationSec: 100 } };
      },
    },
    later: (run, ms) => void pending.push({ run, ms }),
  });
  return { player, pending, asks: () => asks };
}

test("第一次问没连上：隔 1、2、4、8 秒再问，连上了就停", async () => {
  const { player, pending, asks } = setup(2);
  player.watch(7, VIDEO);
  assert.ok(await until(() => player.connected.value === false));
  assert.deepEqual(pending.map(({ ms }) => ms), [RECONNECT_MS[0]]);
  pending.shift()?.run();
  assert.ok(await until(() => pending.length === 1));
  assert.equal(pending[0]?.ms, RECONNECT_MS[1]);
  pending.shift()?.run();
  assert.ok(await until(() => player.connected.value === true));
  assert.equal(asks(), 3);
  assert.equal(pending.length, 0, "连上了不再追问");
  player.stop();
});

test("一直连不上：问完这几次就停；换了视频以后旧的重问作废", async () => {
  const { player, pending, asks } = setup(Number.POSITIVE_INFINITY);
  player.watch(7, VIDEO);
  for (const ms of RECONNECT_MS) {
    assert.ok(await until(() => pending.length === 1));
    assert.equal(pending[0]?.ms, ms);
    pending.shift()?.run();
  }
  assert.ok(await until(() => asks() === RECONNECT_MS.length + 1));
  assert.equal(pending.length, 0);

  player.watch(7, OTHER);
  assert.ok(await until(() => pending.length === 1));
  const stale = pending.shift();
  player.watch(8, VIDEO);
  // 新视频自己问过一次、排上了自己的重问以后，再让旧的那次到点。
  assert.ok(await until(() => pending.length === 1));
  const before = asks();
  stale?.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asks(), before, "作废的重问不再发");
  player.stop();
});
