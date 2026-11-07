// 拼好的服务：一次走遍全部读取，核对请求头，响应都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_URL, PLAYER_URL, SUMMARY_URL, VIEW_URL, WATCH_LATER_URL } from "../../../../src/sites/bilibili/http.ts";
import { createBilibiliService } from "../../../../src/sites/bilibili/service.ts";
import { bilibiliRules } from "../../../../src/sites/bilibili/url.ts";
import { INFO, listing, oneLine, ZH_FILE, ZH_TRACK } from "../../../helpers/bilibili-captions.ts";
import { fakeBackoff, fakeSite, siteCtx, testClock, value, type FakeSite } from "../../../helpers/bilibili-fetch.ts";
import { json, navLoggedIn, viewEnvelope } from "../../../helpers/bilibili-fixtures.ts";

const IDENTITY_HEADERS = ["referer", "user-agent", "cookie", "origin"];

function site(): FakeSite {
  return fakeSite({
    [NAV_URL]: () => json(200, navLoggedIn()),
    [VIEW_URL]: () => json(200, viewEnvelope()),
    [PLAYER_URL]: listing(ZH_TRACK),
    [ZH_FILE]: oneLine(),
    [SUMMARY_URL]: () => json(200, { code: 0, data: { code: 1, stid: "1" } }),
    [WATCH_LATER_URL]: () => json(200, { code: 0, data: { count: 0, list: [] } }),
  });
}

test("视频信息、签名密钥、字幕列表、字幕文件、官方总结、稍后再看的请求都不设 Referer", async () => {
  const fake = site();
  const ctx = siteCtx(fake);
  const service = createBilibiliService();

  const info = value(await service.readVideoInfo(INFO.ref, ctx));
  const [track] = value(await service.listCaptionTracks(info, ctx));
  assert.ok(track);
  value(await service.readCaptions(info, track, ctx));
  value(await service.readOfficialSummary(info, ctx));
  value(await service.readWatchLater(ctx));

  const endpoints = new Set(fake.requests.map((request) => request.endpoint));
  assert.deepEqual(endpoints, new Set([NAV_URL, VIEW_URL, PLAYER_URL, ZH_FILE, SUMMARY_URL, WATCH_LATER_URL]));
  for (const { url, init, headers } of fake.requests) {
    assert.equal("referrer" in init, false, `${url} 不该设 referrer`);
    assert.equal("referrerPolicy" in init, false, `${url} 不该设 referrerPolicy`);
    for (const name of IDENTITY_HEADERS) assert.equal(name in headers, false, `${url} 不该设 ${name}`);
    assert.deepEqual(Object.keys(headers), ["accept"], `${url} 只带 Accept`);
  }
});

test("服务带着 B 站的地址规则和全部读取能力", () => {
  const service = createBilibiliService();
  assert.equal(service.rules, bilibiliRules);
  for (const read of [
    service.readVideoInfo,
    service.listCaptionTracks,
    service.readCaptions,
    service.readOfficialSummary,
    service.readCreatorChapters,
    service.readWatchLater,
  ]) {
    assert.equal(typeof read, "function");
  }
});

test("同一次读取操作里各块读取只确认一次登录，字幕记录跨操作共用", async () => {
  const fake = site();
  const ctx = siteCtx(fake);
  const service = createBilibiliService();

  const info = value(await service.readVideoInfo(INFO.ref, ctx));
  const [track] = value(await service.listCaptionTracks(info, ctx));
  assert.ok(track);
  value(await service.readCreatorChapters(info, ctx));
  value(await service.readCaptions(info, track, ctx));
  assert.equal(fake.calls(NAV_URL).length, 1, "同一次操作只确认一次");

  value(await service.readCreatorChapters(info, siteCtx(fake)));
  assert.equal(fake.calls(NAV_URL).length, 2, "新的操作重新确认");
  assert.equal(fake.calls(PLAYER_URL).length, 1, "字幕记录共用");
});

test("注入的时钟管字幕记录，登录确认不看时钟", async () => {
  const clock = testClock();
  const fake = site();
  const ctx = siteCtx(fake, fakeBackoff());
  const service = createBilibiliService({ now: clock.now });

  value(await service.listCaptionTracks(INFO, ctx));
  clock.at += 5 * 60_000;
  value(await service.listCaptionTracks(INFO, ctx));

  assert.equal(fake.calls(NAV_URL).length, 1, "同一次操作隔多久都不再确认");
  assert.equal(fake.calls(PLAYER_URL).length, 2, "字幕记录过期");
});
