// 模式规则照 PRD 第 6.2 到 6.4 节写成表：打开时按手动、频道、时长的顺序取第一条；长视频在速览里播满 1 分钟切到精读，
// 每次观看最多切一次，撤销后不再切；手动选过就不切；频道偏好不挡自动切换；时长不知道时按长视频算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_SWITCH_SEC, decideMode, isMode, openingMode, SHORT_VIDEO_SEC, type ModeInput, type ModeState } from "../../../../src/core/mode/decide.ts";

const LONG = 20 * 60;
const SHORT = 3 * 60;
const base: ModeInput = { playedSec: 0, autoSwitched: false };

const ROWS: readonly (readonly [string, ModeInput, ModeState])[] = [
  ["长视频、没有偏好：进速览", { ...base, durationSec: LONG }, { mode: "skim", source: "default" }],
  ["短视频、没有偏好：进精读", { ...base, durationSec: SHORT }, { mode: "study", source: "short" }],
  ["正好 5 分钟算长视频", { ...base, durationSec: SHORT_VIDEO_SEC }, { mode: "skim", source: "default" }],
  ["时长不知道：按长视频进速览", base, { mode: "skim", source: "default" }],
  ["频道选过精读：长视频也进精读", { ...base, durationSec: LONG, channelMode: "study" }, { mode: "study", source: "channel" }],
  ["频道选过速览：短视频也进速览", { ...base, durationSec: SHORT, channelMode: "skim" }, { mode: "skim", source: "channel" }],
  [
    "这次手动选过：压过频道和时长",
    { ...base, durationSec: SHORT, channelMode: "study", manualMode: "skim" },
    { mode: "skim", source: "manual" },
  ],
  ["长视频速览里播满 1 分钟：切到精读", { ...base, durationSec: LONG, playedSec: AUTO_SWITCH_SEC }, { mode: "study", source: "auto" }],
  ["差一秒不切", { ...base, durationSec: LONG, playedSec: AUTO_SWITCH_SEC - 1 }, { mode: "skim", source: "default" }],
  ["时长不知道也照常切", { ...base, playedSec: 90 }, { mode: "study", source: "auto" }],
  [
    "频道偏好是速览的长视频：照样自动切",
    { ...base, durationSec: LONG, channelMode: "skim", playedSec: 90 },
    { mode: "study", source: "auto" },
  ],
  ["短视频不自动切", { ...base, durationSec: SHORT, channelMode: "skim", playedSec: 90 }, { mode: "skim", source: "channel" }],
  [
    "这次手动选了速览：播多久都不切",
    { ...base, durationSec: LONG, manualMode: "skim", playedSec: 600 },
    { mode: "skim", source: "manual" },
  ],
  [
    "已经自动切过、还停在精读：保持",
    { ...base, durationSec: LONG, playedSec: 600, autoSwitched: true, current: { mode: "study", source: "auto" } },
    { mode: "study", source: "auto" },
  ],
  [
    "切过以后撤销回了速览：这次观看不再切",
    { ...base, durationSec: LONG, playedSec: 600, autoSwitched: true, current: { mode: "skim", source: "default" } },
    { mode: "skim", source: "default" },
  ],
  [
    "撤销以后又手动选了精读：按手动",
    { ...base, durationSec: LONG, playedSec: 600, autoSwitched: true, manualMode: "study", current: { mode: "skim", source: "default" } },
    { mode: "study", source: "manual" },
  ],
];

for (const [label, input, expected] of ROWS) {
  test(`模式规则：${label}`, () => {
    assert.deepEqual(decideMode(input), expected);
  });
}

test("撤销自动切换回到打开时的模式：有频道偏好时回频道偏好", () => {
  assert.deepEqual(openingMode({ durationSec: LONG, channelMode: "skim" }), { mode: "skim", source: "channel" });
  assert.deepEqual(
    decideMode({ ...base, durationSec: LONG, channelMode: "skim", playedSec: 600, autoSwitched: true, current: { mode: "skim", source: "channel" } }),
    { mode: "skim", source: "channel" },
  );
});

test("只认速览和精读两种模式", () => {
  for (const mode of ["skim", "study"]) assert.equal(isMode(mode), true, mode);
  for (const value of ["english", "SKIM", "", null, 1, undefined]) assert.equal(isMode(value), false, String(value));
});
