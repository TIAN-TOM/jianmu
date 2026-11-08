// 首次启用说明：按「会读取什么」「用来做什么」「本机存什么」分三节，内容来自启用说明表；说明更新时换标题和按钮。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVATION_TABLE, noticeStatus } from "../../../../../src/core/consent.ts";
import { activationCopy, activationSections } from "../../../../../src/pages/shared/ui/activation.ts";

test("完整说明：三节按固定顺序，节内保持表里的顺序，每一条都在", () => {
  const status = noticeStatus(ACTIVATION_TABLE, {});
  assert.equal(status.state, "needed");
  if (status.state !== "needed") return;
  const sections = activationSections(status.items);
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["会读取什么", "用来做什么", "本机存什么"],
  );
  const all = ACTIVATION_TABLE.flatMap((row) => row.items);
  assert.deepEqual(
    sections.flatMap((section) => section.lines),
    [...all.filter((item) => item.kind === "read"), ...all.filter((item) => item.kind === "purpose"), ...all.filter((item) => item.kind === "store")].map((item) => item.text),
  );
});

test("只有新增条目时，没有条目的节不显示", () => {
  const sections = activationSections([{ kind: "read", text: "新加的一样" }]);
  assert.deepEqual(sections, [{ kind: "read", heading: "会读取什么", lines: ["新加的一样"] }]);
  assert.deepEqual(activationSections([]), []);
});

test("从没确认过：标题和按钮是「先看看简幕会读什么」「启用简幕」；说明更新了：换成「简幕要多读一样东西」「继续使用简幕」", () => {
  const fresh = activationCopy(false);
  const updated = activationCopy(true);
  assert.deepEqual([fresh.title, fresh.confirm], ["先看看简幕会读什么", "启用简幕"]);
  assert.deepEqual([updated.title, updated.confirm], ["简幕要多读一样东西", "继续使用简幕"]);
  assert.equal(fresh.footnote, "启用只在本机读取和处理。发给模型服务要另外在设置页同意。");
  assert.equal(updated.saving, "正在启用");
});
