import assert from "node:assert/strict";
import { test } from "node:test";
import { channelKey, parseVideoKey, videoKey, type VideoRef } from "../../../src/core/video-ref.ts";

const BILIBILI_ID = "BV1Sample000";
const YOUTUBE_ID = "sample_ID-01";

test("键的写法：B 站带分 P，第 1 P 也写", () => {
  assert.equal(videoKey({ platform: "bilibili", videoId: BILIBILI_ID }), `bilibili:${BILIBILI_ID}:p1`);
  assert.equal(videoKey({ platform: "bilibili", videoId: BILIBILI_ID, segment: 3 }), `bilibili:${BILIBILI_ID}:p3`);
  assert.equal(videoKey({ platform: "youtube", videoId: YOUTUBE_ID }), `youtube:${YOUTUBE_ID}`);
});

test("键和身份互逆", () => {
  const refs: VideoRef[] = [
    { platform: "bilibili", videoId: BILIBILI_ID, segment: 1 },
    { platform: "bilibili", videoId: BILIBILI_ID, segment: 12 },
    { platform: "youtube", videoId: YOUTUBE_ID },
    { platform: "youtube", videoId: "a" },
    { platform: "youtube", videoId: "x".repeat(64) },
  ];
  for (const ref of refs) assert.deepEqual(parseVideoKey(videoKey(ref)), ref);
});

test("不同视频、不同分 P 的键不同", () => {
  const keys = new Set([
    videoKey({ platform: "bilibili", videoId: BILIBILI_ID, segment: 1 }),
    videoKey({ platform: "bilibili", videoId: BILIBILI_ID, segment: 2 }),
    videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 1 }),
    videoKey({ platform: "youtube", videoId: BILIBILI_ID }),
  ]);
  assert.equal(keys.size, 4);
});

test("不合法的身份不生成键", () => {
  const invalid: VideoRef[] = [
    { platform: "bilibili", videoId: "BV1short" },
    { platform: "bilibili", videoId: "not-a-sample-id" },
    { platform: "bilibili", videoId: BILIBILI_ID, segment: 0 },
    { platform: "bilibili", videoId: BILIBILI_ID, segment: 1.5 },
    { platform: "youtube", videoId: "" },
    { platform: "youtube", videoId: "has:colon" },
    { platform: "youtube", videoId: "x".repeat(65) },
    { platform: "youtube", videoId: YOUTUBE_ID, segment: 1 },
  ];
  for (const ref of invalid) assert.throws(() => videoKey(ref), RangeError);
});

test("认不出的键返回 null", () => {
  const invalid = [
    "",
    "bilibili",
    `bilibili:${BILIBILI_ID}`,
    `bilibili:${BILIBILI_ID}:p0`,
    `bilibili:${BILIBILI_ID}:p01`,
    `bilibili:${BILIBILI_ID}:p1:extra`,
    `bilibili:${BILIBILI_ID}:p99999999999999999999`,
    "bilibili:BV1short:p1",
    "youtube:",
    "youtube:has:colon",
    `tiktok:${YOUTUBE_ID}`,
  ];
  for (const key of invalid) assert.equal(parseVideoKey(key), null, key);
});

test("频道键分平台", () => {
  assert.equal(channelKey({ platform: "bilibili", channelId: "42" }), "bilibili:42");
  assert.notEqual(channelKey({ platform: "bilibili", channelId: "42" }), channelKey({ platform: "youtube", channelId: "42" }));
  assert.throws(() => channelKey({ platform: "youtube", channelId: "" }), RangeError);
});
