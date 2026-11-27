// 哪些窗口开着侧边栏：浏览器报开关就记进会话存储、广播给各页面；后台重启以后照样答得上；
// 关闭没报上来、实际一个侧边栏页面都不在时整张表作废并通知各卡片，核对期间别的窗口刚报的打开不被抹掉；存储里形状不对的不认。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenPanels } from "../../../src/background/open-panels.ts";
import type { Broadcast } from "../../../src/shared/messages.ts";
import { OPEN_PANELS_KEY } from "../../../src/shared/names.ts";
import { nextTurn } from "../../helpers/deferred.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

function world(seed: Record<string, unknown> = {}) {
  const storage = memoryStorage(seed);
  const sent: Broadcast[] = [];
  const state = { anySidePanel: true };
  const create = () => createOpenPanels({ storage, anySidePanel: async () => state.anySidePanel, broadcast: (message) => void sent.push(message) });
  return { storage, sent, state, create, panels: create() };
}

test("开了记下、关了去掉，每次都广播；各窗口分开算，同一个窗口重复报也只记一次", async () => {
  const { panels, storage, sent } = world();
  assert.equal(await panels.isOpen(1), false);

  await panels.changed(1, true);
  await panels.changed(2, true);
  await panels.changed(1, true);
  assert.deepEqual(storage.data[OPEN_PANELS_KEY], [1, 2]);
  assert.deepEqual([await panels.isOpen(1), await panels.isOpen(2), await panels.isOpen(3)], [true, true, false]);

  await panels.changed(1, false);
  assert.deepEqual(storage.data[OPEN_PANELS_KEY], [2]);
  assert.deepEqual([await panels.isOpen(1), await panels.isOpen(2)], [false, true]);
  assert.deepEqual(sent, [
    { type: "panel.changed", windowId: 1, open: true },
    { type: "panel.changed", windowId: 2, open: true },
    { type: "panel.changed", windowId: 1, open: true },
    { type: "panel.changed", windowId: 1, open: false },
  ]);
});

test("两个窗口前后脚报开关：读—改—写排队，谁也不盖掉谁", async () => {
  const { panels, storage } = world();
  await Promise.all([panels.changed(1, true), panels.changed(2, true), panels.changed(3, true), panels.changed(2, false)]);
  assert.deepEqual(storage.data[OPEN_PANELS_KEY], [1, 3]);
});

test("后台被回收又醒来：记在会话存储里的照样算数", async () => {
  const { panels, create } = world();
  await panels.changed(5, true);
  assert.equal(await create().isOpen(5), true);
});

test("记着开着、实际一个侧边栏页面都不在：答没开，整张表作废，记着的窗口各广播一次关了", async () => {
  const { panels, storage, state, sent } = world({ [OPEN_PANELS_KEY]: [1, 2] });
  state.anySidePanel = false;
  assert.equal(await panels.isOpen(1), false);
  assert.deepEqual(storage.data[OPEN_PANELS_KEY], []);
  assert.deepEqual(sent, [
    { type: "panel.changed", windowId: 1, open: false },
    { type: "panel.changed", windowId: 2, open: false },
  ]);
  state.anySidePanel = true;
  assert.equal(await panels.isOpen(2), false);
  assert.equal(sent.length, 2, "已经作废的不再广播");
});

test("核对有没有侧边栏页面的这一会儿，别的窗口刚报了打开：过时的结果不把它抹掉", async () => {
  const storage = memoryStorage({ [OPEN_PANELS_KEY]: [1] });
  const sent: Broadcast[] = [];
  let asked = 0;
  let answerFirst: (any: boolean) => void = () => undefined;
  const panels = createOpenPanels({
    storage,
    // 第一次问的时候一个都不在，回答迟迟不来；之后窗口 2 的侧边栏开了。
    anySidePanel: () => ((asked += 1) === 1 ? new Promise((resolve) => (answerFirst = resolve)) : Promise.resolve(true)),
    broadcast: (message) => void sent.push(message),
  });
  const stale = panels.isOpen(1);
  while (asked === 0) await nextTurn();
  await panels.changed(2, true);
  answerFirst(false);
  await stale;
  assert.deepEqual(storage.data[OPEN_PANELS_KEY], [1, 2], "没有整表清空");
  assert.equal(await panels.isOpen(2), true);
  assert.deepEqual(sent, [{ type: "panel.changed", windowId: 2, open: true }], "也没有广播谁关了");
});

test("存储里形状不对的不认：不是数组当没有，数组里不是整数的丢掉", async () => {
  for (const stored of [null, "1", { 1: true }, 7]) {
    assert.equal(await world({ [OPEN_PANELS_KEY]: stored }).panels.isOpen(7), false, JSON.stringify(stored));
  }
  const { panels, storage } = world({ [OPEN_PANELS_KEY]: [1, "2", null, 2.5, 3] });
  assert.equal(await panels.isOpen(3), true);
  await panels.changed(4, true);
  assert.deepEqual(storage.data[OPEN_PANELS_KEY], [1, 3, 4]);
});
