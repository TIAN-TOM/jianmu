// 「已切到精读」那一行（PRD 6.3）：自动切到精读时显示；只在看得见、点得到时计时，看够 30 秒收起；
// 暂停计时不丢已看的时间；撤销以后、换到没自动切过的视频时不显示；换视频再回来接着算。
import assert from "node:assert/strict";
import { signal } from "@preact/signals";
import { test } from "node:test";
import type { ModeView } from "../../../../src/pages/sidepanel/mode.ts";
import { createUndoLine, UNDO_TICK_MS, UNDO_VISIBLE_MS } from "../../../../src/pages/sidepanel/undo-line.ts";

const AUTO: ModeView = { mode: "study", source: "auto", autoSwitched: true };
const UNDONE: ModeView = { mode: "skim", source: "default", autoSwitched: true };

function setup(initial: ModeView = AUTO) {
  let clock = 0;
  const timers = new Set<() => void>();
  const mode = signal<ModeView>(initial);
  const line = createUndoLine({
    mode,
    now: () => clock,
    every: (_ms, run) => {
      timers.add(run);
      return () => void timers.delete(run);
    },
  });
  /** 过 ms 毫秒，每一步跑一次定时器。 */
  const pass = (ms: number) => {
    for (let left = ms; left > 0; left -= UNDO_TICK_MS) {
      clock += Math.min(UNDO_TICK_MS, left);
      for (const run of [...timers]) run();
    }
  };
  return { mode, line, pass, timers };
}

test("自动切到精读时显示；看得见、点得到地看够 30 秒收起", () => {
  const { line, pass } = setup();
  line.bind("7\nv1");
  assert.equal(line.shown.value, true);
  line.setCounting(true);
  pass(UNDO_VISIBLE_MS - UNDO_TICK_MS);
  assert.equal(line.shown.value, true);
  pass(UNDO_TICK_MS);
  assert.equal(line.shown.value, false);
});

test("被盖住、标签页不在前台时不计时；回来接着算，已经看过的不丢", () => {
  const { line, pass, timers } = setup();
  line.bind("7\nv1");
  line.setCounting(true);
  pass(20_000);
  line.setCounting(false);
  assert.equal(timers.size, 0, "停了就不再跑定时器");
  pass(10 * 60_000);
  assert.equal(line.shown.value, true, "盖住的这段时间不算");
  line.setCounting(true);
  pass(10_000);
  assert.equal(line.shown.value, false);
});

test("侧边栏关着时自动切的：第一次打开看得见时才开始算", () => {
  const { line, pass } = setup();
  pass(5 * 60_000);
  line.bind("7\nv1");
  assert.equal(line.shown.value, true);
});

test("撤销以后不显示；没自动切过不显示，也不开定时器", () => {
  const { mode, line, timers } = setup();
  line.bind("7\nv1");
  line.setCounting(true);
  mode.value = UNDONE;
  assert.equal(line.shown.value, false);
  const plain = setup({ mode: "skim", source: "default", autoSwitched: false });
  plain.line.bind("7\nv1");
  plain.line.setCounting(true);
  assert.equal(plain.timers.size, 0);
  assert.equal(plain.line.shown.value, false);
  assert.ok(timers.size <= 1);
});

test("换视频：各算各的，换回来接着算", () => {
  const { line, pass } = setup();
  line.bind("7\nv1");
  line.setCounting(true);
  pass(25_000);
  line.bind("7\nv2");
  line.setCounting(true);
  pass(25_000);
  assert.equal(line.shown.value, true, "第二个视频才看了 25 秒");
  line.bind("7\nv1");
  line.setCounting(true);
  pass(5_000);
  assert.equal(line.shown.value, false, "第一个视频 25 + 5 秒");
  line.bind(null);
  assert.equal(line.shown.value, false);
});
