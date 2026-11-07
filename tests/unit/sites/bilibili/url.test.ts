import assert from "node:assert/strict";
import { test } from "node:test";
import { videoKey, type VideoRef } from "../../../../src/core/video-ref.ts";
import {
  AV_XOR_CODE,
  avToBv,
  BV_ALPHABET,
  bilibiliRules,
  canonicalUrl,
  parseBvid,
  parseWatchUrl,
  videoFromUrl,
} from "../../../../src/sites/bilibili/url.ts";
import { siteRules } from "../../../../src/sites/rules.ts";

const BV = "BV1Sample000";
const OTHER_BV = "BV1Sample001";
// 范围上限的 av 号，不对应真实视频。
const AV = "2251799813685247";
const AV_AS_BV = "BV1aPPTfmvQq";

const ref = (videoId: string, segment = 1): VideoRef => ({ platform: "bilibili", videoId, segment });
const fromUrl = (url: string): VideoRef | null => videoFromUrl(new URL(url));

// 只在测试里用的反向换算，用来做往返核对。
const DIGIT_ORDER = [9, 7, 5, 6, 4, 8, 3, 10, 11];
function bvToAv(bv: string): bigint {
  const value = DIGIT_ORDER.reduce((sum, index) => sum * 58n + BigInt(BV_ALPHABET.indexOf(bv.charAt(index))), 0n);
  return (value & ((1n << 51n) - 1n)) ^ AV_XOR_CODE;
}

test("从播放页 URL 与裸字符串里解析 BV 号", () => {
  assert.equal(parseBvid(`https://www.bilibili.com/video/${BV}?p=2`), BV);
  assert.equal(parseBvid(BV), BV);
  assert.equal(parseBvid("https://www.bilibili.com/"), null);
  assert.equal(parseBvid(null), null);
});

test("解析分 P 序号，缺省为第 1 P", () => {
  assert.equal(parseWatchUrl(`https://www.bilibili.com/video/${BV}?p=3`)?.segment, 3);
  assert.equal(parseWatchUrl(`https://www.bilibili.com/video/${BV}`)?.segment, 1);
  assert.equal(parseWatchUrl(`https://www.bilibili.com/video/${BV}?p=0`)?.segment, 1);
});

test("时间戳深链使用 B 站的 ?t=秒 形式", () => {
  assert.equal(canonicalUrl(ref(BV), 95), `https://www.bilibili.com/video/${BV}?t=95`);
  assert.equal(canonicalUrl(ref(BV, 2), 95), `https://www.bilibili.com/video/${BV}?p=2&t=95`);
  assert.equal(canonicalUrl(ref(BV), 0), `https://www.bilibili.com/video/${BV}`);
  assert.equal(canonicalUrl(ref(BV)), `https://www.bilibili.com/video/${BV}`);
  assert.throws(() => canonicalUrl(ref("notabvid"), 10), /BV/);
});

test("av 号换 BV 号：范围上限的样例，往返对得上，范围外和不是数字的返回空", () => {
  assert.equal(avToBv(AV), AV_AS_BV);
  assert.equal(avToBv(BigInt(AV)), AV_AS_BV);
  assert.equal(bvToAv(AV_AS_BV), BigInt(AV));
  for (const aid of [1n, 58n, 999_999_937n, 2n ** 31n + 7n, 2n ** 51n - 2n]) {
    const bv = avToBv(aid);
    assert.ok(bv, `av${aid}`);
    assert.match(bv, /^BV[0-9A-Za-z]{10}$/);
    assert.equal(bvToAv(bv), aid, `av${aid}`);
  }
  for (const bad of ["0", "-1", String(2n ** 51n), "12x", ""]) {
    assert.equal(avToBv(bad), null, `「${bad}」不是有效的 av 号`);
  }
});

test("共用模块只拆地址、不认来源：BV 号大小写、语言前缀、av 老地址和分 P", () => {
  assert.equal(parseBvid(`https://evil.example/?q=${BV}`), BV, "认不认这个来源由调用方定");
  assert.equal(parseBvid("bv1Sample000"), null, "前缀 BV 区分大小写");
  assert.equal(parseBvid(""), null);
  assert.equal(fromUrl(`https://x.example/video/av${AV}/`)?.videoId, AV_AS_BV);
  assert.equal(fromUrl(`https://x.example/zh-Hans/video/AV${AV}`)?.videoId, AV_AS_BV);
  assert.equal(fromUrl(`https://x.example/video/av${AV}x`), null);
  assert.equal(fromUrl(`https://x.example/space/video/av${AV}`), null);
  assert.equal(fromUrl(`https://x.example/list/ml1?bvid=${OTHER_BV}`)?.videoId, OTHER_BV);
  assert.equal(fromUrl(`https://x.example/all?keyword=${BV}`), null);
  for (const [query, segment] of [["?p=3", 3], ["?t=5&p=2", 2], ["?p=0", 1], ["?p=x", 1], ["", 1]] as const) {
    assert.equal(fromUrl(`https://x.example/video/${BV}${query}`)?.segment, segment, query);
  }
});

test("侧边栏只认 B站的地址：外站把 bilibili.com 写进路径、参数或域名都不算", () => {
  const cases: Readonly<Record<string, string | null>> = {
    [`https://www.bilibili.com/video/${BV}`]: BV,
    [`https://www.bilibili.com/video/${BV}/?p=2&spm_id_from=333.1007`]: BV,
    [`https://m.bilibili.com/video/${BV}`]: BV,
    [`https://bilibili.com/video/${BV}`]: BV,
    [`http://www.bilibili.com/video/${BV}`]: BV,
    [`https://www.bilibili.com/zh-Hans/video/${OTHER_BV}/?p=2`]: OTHER_BV,
    [`https://www.bilibili.com/en/video/${OTHER_BV}`]: OTHER_BV,
    [`https://www.bilibili.com/list/ml1234?bvid=${OTHER_BV}`]: OTHER_BV,
    [`https://www.bilibili.com/zh-Hant/list/watchlater?bvid=${OTHER_BV}`]: OTHER_BV,
    [`https://www.bilibili.com/list/watchlater/${OTHER_BV}`]: OTHER_BV,
    [`https://evil.example/?ref=bilibili.com&bvid=${BV}`]: null,
    [`https://evil.example/bilibili.com/video/${BV}`]: null,
    [`https://notbilibili.com/video/${BV}`]: null,
    [`https://bilibili.com.evil.example/video/${BV}`]: null,
    [`https://search.example/?q=${BV}`]: null,
    [`chrome-extension://sample-id/card.html#bvid=${BV}`]: null,
    [`ftp://www.bilibili.com/video/${BV}`]: null,
    [`https://space.bilibili.com/123456/video/${OTHER_BV}`]: null,
    [`https://search.bilibili.com/all?keyword=${BV}`]: null,
    "https://www.bilibili.com/zh-Hans/": null,
    "not a url": null,
    "": null,
  };
  for (const [url, videoId] of Object.entries(cases)) {
    assert.equal(parseWatchUrl(url)?.videoId ?? null, videoId, url);
  }
});

test("侧边栏认得出 av 号的老地址，按换算出的 BV 号取字幕，分 P 照旧", () => {
  const cases: Readonly<Record<string, VideoRef | null>> = {
    [`https://www.bilibili.com/video/av${AV}`]: ref(AV_AS_BV),
    [`https://www.bilibili.com/video/av${AV}/?p=2`]: ref(AV_AS_BV, 2),
    [`https://www.bilibili.com/video/AV${AV}`]: ref(AV_AS_BV),
    [`https://www.bilibili.com/zh-Hans/video/av${AV}`]: ref(AV_AS_BV),
    "https://www.bilibili.com/video/av0": null,
    [`https://www.bilibili.com/video/av${AV}x`]: null,
    [`https://evil.example/video/av${AV}`]: null,
  };
  for (const [url, expected] of Object.entries(cases)) {
    assert.deepEqual(bilibiliRules.parseWatchUrl(url), expected, url);
  }
});

test("内容脚本在 av 号的播放页上照样插卡片，播放器跳转认换算出的 BV 号", () => {
  for (const href of [`https://www.bilibili.com/video/av${AV}`, `https://www.bilibili.com/zh-Hans/video/av${AV}/?p=1`]) {
    assert.deepEqual(bilibiliRules.parseWatchUrl(href), ref(AV_AS_BV), href);
  }
});

test("卡片在 av 号的播放页上按换算出的 BV 号读总结", () => {
  const video = bilibiliRules.parseWatchUrl(`https://www.bilibili.com/video/av${AV}?p=2`);
  assert.ok(video);
  assert.equal(videoKey(video), `bilibili:${AV_AS_BV}:p2`);
});

test("地址规则表里的 B 站规则就是这份解析", () => {
  assert.equal(siteRules.bilibili, bilibiliRules);
  assert.equal(bilibiliRules.platform, "bilibili");
  assert.equal(bilibiliRules.optionalPermission, false);
  assert.equal(siteRules.youtube, undefined);
});

test("列表页的视频号参数只在列表页认", () => {
  assert.equal(parseWatchUrl(`https://www.bilibili.com/list/ml1?bvid=${BV}`)?.videoId, BV);
  assert.equal(parseWatchUrl(`https://www.bilibili.com/en/list/ml1?bvid=${BV}`)?.videoId, BV);
  assert.equal(parseWatchUrl(`https://www.bilibili.com/list/ml1?bvid=${BV}x`), null);
  for (const path of ["/", "/video/", "/medialist/ml1", "/all"]) {
    assert.equal(parseWatchUrl(`https://www.bilibili.com${path}?bvid=${BV}`), null, path);
  }
  assert.equal(parseWatchUrl(`https://www.bilibili.com/video/${OTHER_BV}?bvid=${BV}`)?.videoId, OTHER_BV, "路径里的视频号优先");
});

test("分 P 非法值都当第 1 P", () => {
  for (const value of ["", "0", "-1", "x", "2x", "1.5", "99999999999999999999"]) {
    const video = parseWatchUrl(`https://www.bilibili.com/video/${BV}?p=${value}`);
    assert.equal(video?.segment, 1, value);
    assert.ok(video && videoKey(video), "拆出来的身份都能进键");
  }
  assert.equal(parseWatchUrl(`https://www.bilibili.com/video/${BV}?p=12`)?.segment, 12);
});

test("追踪参数和起播时间不进身份", () => {
  const plain = parseWatchUrl(`https://www.bilibili.com/video/${BV}`);
  assert.deepEqual(parseWatchUrl(`https://www.bilibili.com/video/${BV}/?spm_id_from=333.1007&t=95&vd_source=abc`), plain);
});

test("番剧和课堂的页面不认", () => {
  for (const path of ["/bangumi/play/ep1", `/bangumi/play/${BV}`, "/cheese/play/ep1", `/cheese/play/${BV}`]) {
    assert.equal(parseWatchUrl(`https://www.bilibili.com${path}`), null, path);
  }
});

test("规范链接解析回来是同一个视频", () => {
  for (const video of [ref(BV), ref(BV, 2), ref(OTHER_BV, 12)]) {
    assert.deepEqual(parseWatchUrl(canonicalUrl(video, 95)), video);
  }
  assert.equal(canonicalUrl({ platform: "bilibili", videoId: BV }, 1.9), `https://www.bilibili.com/video/${BV}?t=1`);
  assert.equal(canonicalUrl(ref(BV), -5), `https://www.bilibili.com/video/${BV}`);
});
