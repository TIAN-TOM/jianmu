import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVideoKey, videoKey, type VideoRef } from "../../../../src/core/video-ref.ts";
import { siteRules } from "../../../../src/sites/rules.ts";
import { canonicalUrl, parseWatchUrl, youtubeRules } from "../../../../src/sites/youtube/url.ts";

// 自造的编号，只照着字符集和长度写，不对应真实视频。
const ID = "jmSample0001";
const OTHER_ID = "jm_Sample-02";
const WATCH = "https://www.youtube.com/watch";

const ref = (videoId: string): VideoRef => ({ platform: "youtube", videoId });

test("地址表：只认 YouTube 站点的观看页，起播时间、播放列表和追踪参数不进身份", () => {
  const table: readonly (readonly [string, VideoRef | null])[] = [
    [`${WATCH}?v=${ID}`, ref(ID)],
    [`${WATCH}?v=${OTHER_ID}`, ref(OTHER_ID)],
    [`${WATCH}?v=${ID}&t=95s`, ref(ID)],
    [`${WATCH}?v=${ID}&t=1m35s`, ref(ID)],
    [`${WATCH}?v=${ID}&start=95`, ref(ID)],
    [`${WATCH}?v=${ID}&list=jmList0001&index=3`, ref(ID)],
    [`${WATCH}?list=jmList0001&v=${ID}&pp=sample`, ref(ID)],
    [`${WATCH}?v=${ID}&si=sample&feature=share`, ref(ID)],
    [`${WATCH}?v=${ID}#comments`, ref(ID)],
    [`${WATCH}?v=${"a".repeat(64)}`, ref("a".repeat(64))],
    [`${WATCH}?v=x`, ref("x")],
  ];
  for (const [url, expected] of table) {
    assert.deepEqual(parseWatchUrl(url), expected, url);
  }
});

test("地址表：Shorts、嵌入页、没有编号、编号不合法、超长都不认", () => {
  const table: readonly string[] = [
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/`,
    `https://www.youtube.com/results?search_query=${ID}`,
    `https://www.youtube.com/playlist?list=jmList0001`,
    `${WATCH}`,
    `${WATCH}?list=jmList0001`,
    `${WATCH}?v=`,
    `${WATCH}?v=jm.Sample`,
    `${WATCH}?v=jm%20Sample`,
    `${WATCH}?v=jm/Sample`,
    `${WATCH}?v=${encodeURIComponent("样例")}`,
    `${WATCH}?v=${"a".repeat(65)}`,
    `${WATCH}?v=${ID}&v=${OTHER_ID}`,
    `${WATCH}/?v=${ID}`,
    `https://www.youtube.com/Watch?v=${ID}`,
  ];
  for (const url of table) {
    assert.equal(parseWatchUrl(url), null, url);
  }
});

test("地址表：别的主机、别的协议、带端口或账号的写法都不认", () => {
  const table: readonly string[] = [
    `http://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com.example/watch?v=${ID}`,
    `https://sample.example/watch?v=${ID}&next=https://www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    `https://user@www.youtube.com/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    "not a url",
    "",
  ];
  for (const url of table) {
    assert.equal(parseWatchUrl(url), null, url);
  }
});

test("规范链接只从身份生成，带时间点时加整秒", () => {
  assert.equal(canonicalUrl(ref(ID)), `${WATCH}?v=${ID}`);
  assert.equal(canonicalUrl(ref(ID), 0), `${WATCH}?v=${ID}`);
  assert.equal(canonicalUrl(ref(ID), 0.9), `${WATCH}?v=${ID}`);
  assert.equal(canonicalUrl(ref(ID), 95.7), `${WATCH}?v=${ID}&t=95s`);
  assert.equal(canonicalUrl(ref(OTHER_ID), 3600), `${WATCH}?v=${OTHER_ID}&t=3600s`);
  for (const atSec of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(canonicalUrl(ref(ID), atSec), `${WATCH}?v=${ID}`, String(atSec));
  }
});

test("规范链接拒绝不合法的身份", () => {
  assert.throws(() => canonicalUrl(ref("jm.Sample")), RangeError);
  assert.throws(() => canonicalUrl(ref("")), RangeError);
  assert.throws(() => canonicalUrl(ref("a".repeat(65))), RangeError);
  assert.throws(() => canonicalUrl({ platform: "bilibili", videoId: ID }), RangeError);
  assert.throws(() => canonicalUrl({ platform: "youtube", videoId: ID, segment: 1 }), RangeError);
});

test("规范链接解析回来是同一个视频，视频键和身份规则一致", () => {
  for (const videoId of [ID, OTHER_ID, "a".repeat(64), "x"]) {
    const parsed = parseWatchUrl(canonicalUrl(ref(videoId), 42));
    assert.deepEqual(parsed, ref(videoId));
    assert.ok(parsed);
    assert.deepEqual(parseVideoKey(videoKey(parsed)), ref(videoId));
  }
});

test("地址规则表里登记了 YouTube：要用户另外授权，授权来源和注册的匹配规则都只有站点这一条", () => {
  assert.equal(siteRules.youtube, youtubeRules);
  assert.equal(youtubeRules.platform, "youtube");
  assert.equal(youtubeRules.optionalPermission, true);
  assert.deepEqual(youtubeRules.permissionOrigins, ["https://www.youtube.com/*"]);
  assert.deepEqual(youtubeRules.scriptMatches, ["https://www.youtube.com/*"]);
  assert.equal(youtubeRules.parseWatchUrl, parseWatchUrl);
  assert.equal(youtubeRules.canonicalUrl, canonicalUrl);
});

test("两站的地址规则互不认对方的观看页", () => {
  const bilibili = siteRules.bilibili;
  assert.ok(bilibili);
  assert.equal(bilibili.parseWatchUrl(`${WATCH}?v=${ID}`), null);
  assert.equal(youtubeRules.parseWatchUrl("https://www.bilibili.com/video/BV1Sample000"), null);
});
