// 共用组件里的几条小规则：方向键在一组控件里移动、一行提示按优先级挑一条、菜单的位置、状态块的文案。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe as describeError } from "../../../../../src/core/errors.ts";
import { rovingTarget } from "../../../../../src/pages/shared/ui/keys.ts";
import { MENU_GAP, menuPlacement, VIEWPORT_MARGIN } from "../../../../../src/pages/shared/ui/menu.ts";
import { pickNotice } from "../../../../../src/pages/shared/ui/notice.ts";
import { stateCopy } from "../../../../../src/pages/shared/ui/state.ts";

test("单选组：左右（和上下）方向键在两头之间绕回，Home、End 到头尾", () => {
  assert.equal(rovingTarget("ArrowRight", 0, 2, "both"), 1);
  assert.equal(rovingTarget("ArrowRight", 1, 2, "both"), 0);
  assert.equal(rovingTarget("ArrowLeft", 0, 2, "both"), 1);
  assert.equal(rovingTarget("ArrowDown", 0, 2, "both"), 1);
  assert.equal(rovingTarget("Home", 1, 2, "both"), 0);
  assert.equal(rovingTarget("End", 0, 2, "both"), 1);
});

test("菜单只认上下键；不归这组控件管的键回 null，事件留给页面", () => {
  assert.equal(rovingTarget("ArrowDown", 2, 3, "vertical"), 0);
  assert.equal(rovingTarget("ArrowUp", 0, 3, "vertical"), 2);
  assert.equal(rovingTarget("ArrowRight", 0, 3, "vertical"), null);
  assert.equal(rovingTarget("Enter", 0, 3, "both"), null);
  assert.equal(rovingTarget("ArrowDown", 0, 0, "vertical"), null, "空的一组");
});

test("焦点不在组里时：往后从第一个开始，往前从最后一个开始", () => {
  assert.equal(rovingTarget("ArrowDown", -1, 3, "vertical"), 0);
  assert.equal(rovingTarget("ArrowUp", -1, 3, "vertical"), 2);
});

test("一行提示一次只显示一条：数小的优先，同样优先取先交进来的，不成立的跳过", () => {
  const consent = { id: "consent", priority: 1 };
  const remembered = { id: "remembered", priority: 6 };
  const batch = { id: "batch", priority: 7 };
  const other = { id: "other", priority: 6 };
  assert.equal(pickNotice([batch, remembered, consent]), consent);
  assert.equal(pickNotice([remembered, other]), remembered);
  assert.equal(pickNotice([false, null, undefined, batch]), batch);
  assert.equal(pickNotice([{ id: "bad", priority: Number.NaN }]), null);
  assert.equal(pickNotice([]), null);
});

const VIEWPORT = { width: 360, height: 640 };

test("菜单贴着按钮下方、右边对齐", () => {
  const trigger = { left: 300, top: 40, right: 328, bottom: 68 };
  assert.deepEqual(menuPlacement(trigger, { width: 180, height: 120 }, VIEWPORT), { left: 148, top: 68 + MENU_GAP });
});

test("下面放不下而上面更宽，就翻到按钮上面", () => {
  const trigger = { left: 300, top: 560, right: 328, bottom: 588 };
  assert.deepEqual(menuPlacement(trigger, { width: 180, height: 120 }, VIEWPORT), { left: 148, top: 560 - MENU_GAP - 120 });
});

test("菜单不出视口：左边贴着边距，太高的贴着上边距", () => {
  const trigger = { left: 10, top: 40, right: 38, bottom: 68 };
  assert.equal(menuPlacement(trigger, { width: 180, height: 120 }, VIEWPORT).left, VIEWPORT_MARGIN);
  const tall = menuPlacement({ left: 300, top: 300, right: 328, bottom: 328 }, { width: 180, height: 900 }, VIEWPORT);
  assert.equal(tall.top, VIEWPORT_MARGIN);
  const wide = menuPlacement({ left: 300, top: 40, right: 328, bottom: 68 }, { width: 500, height: 100 }, VIEWPORT);
  assert.equal(wide.left, VIEWPORT_MARGIN, "比视口还宽时左边贴着边距");
});

test("状态块的文案：现在每个错误码只有一句话，写在原因那一段，影响先留空", () => {
  assert.deepEqual(stateCopy("NO_CAPTIONS"), { title: describeError("NO_CAPTIONS") });
  assert.equal(stateCopy("RATE_LIMITED").impact, undefined);
});
