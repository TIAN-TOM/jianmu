// 字幕列表的内存记录、在途合并和地址边界：请求走严格替身，响应都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_URL, PLAYER_URL } from "../../../../src/sites/bilibili/http.ts";
import type { CaptionTrack, VideoInfo } from "../../../../src/sites/types.ts";
import { EN_FILE, EN_TRACK, INFO, listing, oneLine, playerEnvelope, rig, ZH_FILE, ZH_TRACK } from "../../../helpers/bilibili-captions.ts";
import { failure, hanging, siteCtx, value, type Route } from "../../../helpers/bilibili-fetch.ts";
import { json, navLoggedOut } from "../../../helpers/bilibili-fixtures.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";

const ZH: CaptionTrack = { trackId: "zh-CN", lang: "zh-CN", label: "中文（中国）", kind: "human" };
const EN: CaptionTrack = { trackId: "en-US", lang: "en-US", label: "英语", kind: "human" };
const NEW_FILE = "https://i0.hdslb.com/bfs/subtitle/zh-new.json";
const NEW_ZH_TRACK = { ...ZH_TRACK, subtitle_url: NEW_FILE };
const RECORD_MS = 5 * 60_000;

const htmlPage: Route = () => new Response("<html>sample</html>", { status: 200 });

async function waitForCall(calls: () => number): Promise<void> {
  while (calls() === 0) await nextTurn();
}

test("列轨结果里没有字幕地址", async () => {
  const { captions, ctx } = rig({ [PLAYER_URL]: listing(ZH_TRACK, EN_TRACK) });

  const tracks = value(await captions.listCaptionTracks(INFO, ctx));

  assert.equal(tracks.length, 2);
  assert.doesNotMatch(JSON.stringify(tracks), /hdslb|subtitle/);
});

test("协议相对的字幕地址补上 https，完整的 https 地址不变", async () => {
  const { captions, ctx, fake } = rig({
    [PLAYER_URL]: listing({ ...ZH_TRACK, subtitle_url: ZH_FILE }, EN_TRACK),
    [ZH_FILE]: oneLine(),
    [EN_FILE]: oneLine(),
  });

  value(await captions.readCaptions(INFO, ZH, ctx));
  value(await captions.readCaptions(INFO, EN, ctx));

  assert.deepEqual(
    fake.requests.slice(-2).map((request) => request.url),
    [ZH_FILE, EN_FILE],
  );
});

test("地址不可信的字幕轨丢掉，留下的轨照常读", async () => {
  for (const subtitle_url of [
    "//files.example.test/bfs/subtitle/en.json",
    "https://i0.hdslb.com.example.test/bfs/subtitle/en.json",
    "http://i0.hdslb.com/bfs/subtitle/en.json",
    "javascript:void(0)",
    "不是地址",
    123,
    null,
  ]) {
    const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK, { ...EN_TRACK, subtitle_url }) });

    const tracks = value(await captions.listCaptionTracks(INFO, ctx));

    assert.deepEqual(tracks.map((track) => track.trackId), ["zh-CN"], String(subtitle_url));
    assert.equal(failure(await captions.readCaptions(INFO, EN, ctx)).code, "NO_CAPTIONS");
    assert.equal(fake.requests.filter((request) => !request.url.startsWith("https://api.")).length, 0);
  }
});

test("一条能用的地址都没有时报 MALFORMED，分段照常读得到", async () => {
  const points = [{ from: 0, to: 30, content: "开场" }];
  const body = playerEnvelope([{ ...ZH_TRACK, subtitle_url: "//files.example.test/zh.json" }], { view_points: points });
  const { captions, ctx } = rig({ [PLAYER_URL]: () => json(200, body) });

  const result = failure(await captions.listCaptionTracks(INFO, ctx));

  assert.equal(result.code, "MALFORMED");
  assert.equal(result.detail, "no-usable-url");
  assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).detail, "no-usable-url");
  assert.deepEqual(value(await captions.readCreatorChapters(INFO, ctx)), [{ title: "开场", start: 0, end: 30 }]);
});

test("同一语言只留第一条", async () => {
  const { captions, ctx, fake } = rig({
    [PLAYER_URL]: listing(ZH_TRACK, { ...ZH_TRACK, subtitle_url: EN_FILE }),
    [ZH_FILE]: oneLine(),
  });

  assert.equal(value(await captions.listCaptionTracks(INFO, ctx)).length, 1);
  value(await captions.readCaptions(INFO, ZH, ctx));

  assert.equal(fake.calls(ZH_FILE).length, 1);
});

test("机器生成的标记和语言码前缀都算自动字幕", async () => {
  const { captions, ctx } = rig({
    [PLAYER_URL]: listing(
      { ...ZH_TRACK, lan: "a", ai_status: 1 },
      { ...EN_TRACK, lan: "b", ai_type: 1 },
      { ...ZH_TRACK, lan: "ai-ja", subtitle_url: "//i0.hdslb.com/bfs/subtitle/ja.json" },
      { ...ZH_TRACK, lan: "ko", subtitle_url: "//i0.hdslb.com/bfs/subtitle/ko.json", ai_status: 0, ai_type: 0 },
    ),
  });

  const kinds = value(await captions.listCaptionTracks(INFO, ctx)).map((track) => track.kind);

  assert.deepEqual(kinds, ["auto", "auto", "auto", "human"]);
});

test("读字幕用列轨时记下的地址，不再发列表请求", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine() });

  value(await captions.listCaptionTracks(INFO, ctx));
  value(await captions.listCaptionTracks(INFO, ctx));
  value(await captions.readCaptions(INFO, ZH, ctx));

  assert.equal(fake.calls(PLAYER_URL).length, 1);
  assert.equal(fake.calls(ZH_FILE).length, 1);
});

test("内存表里没有地址时重列一次；重列以后还没有这条轨时报 NO_CAPTIONS", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine("读到了") });

  assert.equal(value(await captions.readCaptions(INFO, ZH, ctx))[0]?.text, "读到了");
  assert.equal(fake.calls(PLAYER_URL).length, 1);

  const gone = failure(await captions.readCaptions(INFO, EN, ctx));
  assert.equal(gone.code, "NO_CAPTIONS");
  assert.equal(fake.calls(PLAYER_URL).length, 2, "记录里没有这条轨，只重列一次");
});

test("空列表不记，下一次重新列", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing() });

  assert.deepEqual(value(await captions.listCaptionTracks(INFO, ctx)), []);
  fake.routes.set(PLAYER_URL, listing(ZH_TRACK));

  assert.equal(value(await captions.listCaptionTracks(INFO, ctx)).length, 1);
  assert.equal(fake.calls(PLAYER_URL).length, 2);
});

test("fresh 列出空列表时删掉旧记录：已经不在的轨不会再被读出来", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine() });

  value(await captions.listCaptionTracks(INFO, ctx));
  fake.routes.set(PLAYER_URL, listing());
  assert.deepEqual(value(await captions.listCaptionTracks(INFO, ctx, { fresh: true })), []);

  assert.deepEqual(value(await captions.listCaptionTracks(INFO, ctx)), []);
  assert.equal(fake.calls(PLAYER_URL).length, 3, "旧记录删了，重新列");
  assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).code, "NO_CAPTIONS");
  assert.equal(fake.calls(ZH_FILE).length, 0, "不用旧地址下载");
});

test("fresh 列表被拒绝时删掉旧记录：后面的读取重新列，不用旧地址", async () => {
  const refusals: readonly (readonly [string, Route])[] = [
    ["要登录才给字幕", () => json(200, playerEnvelope([ZH_TRACK], { need_login_subtitle: true }))],
    ["不让看", () => json(200, { code: -403, message: "sample refusal" })],
    ["找不到", () => json(200, { code: -404, message: "sample refusal" })],
  ];
  for (const [label, refused] of refusals) {
    const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine(), [NEW_FILE]: oneLine() });
    value(await captions.listCaptionTracks(INFO, ctx));
    fake.routes.set(PLAYER_URL, refused);
    failure(await captions.listCaptionTracks(INFO, ctx, { fresh: true }));

    fake.routes.set(PLAYER_URL, listing(NEW_ZH_TRACK));
    value(await captions.listCaptionTracks(INFO, ctx));
    value(await captions.readCaptions(INFO, ZH, ctx));

    assert.equal(fake.calls(PLAYER_URL).length, 3, `${label}：旧记录删了，重新列`);
    assert.equal(fake.calls(ZH_FILE).length, 0, `${label}：不用旧地址下载`);
    assert.equal(fake.calls(NEW_FILE).length, 1, label);
  }
});

test("fresh 列表被限流或超时：记录留着", async () => {
  const transient: readonly (readonly [string, Route])[] = [
    ["限流", () => new Response("sample refusal", { status: 429 })],
    ["超时", hanging],
  ];
  for (const [label, broken] of transient) {
    const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK) }, { requestTimeoutMs: 20 });
    value(await captions.listCaptionTracks(INFO, ctx));
    fake.routes.set(PLAYER_URL, broken);
    failure(await captions.listCaptionTracks(INFO, ctx, { fresh: true }));

    assert.equal(value(await captions.listCaptionTracks(INFO, ctx)).length, 1, label);
    assert.equal(fake.calls(PLAYER_URL).length, 2, `${label}：不再发列表请求`);
  }
});

test("fresh 不读记录，结果照常写回", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [NEW_FILE]: oneLine() });

  value(await captions.listCaptionTracks(INFO, ctx));
  fake.routes.set(PLAYER_URL, listing(NEW_ZH_TRACK));
  value(await captions.listCaptionTracks(INFO, ctx, { fresh: true }));
  assert.equal(fake.calls(PLAYER_URL).length, 2);

  value(await captions.listCaptionTracks(INFO, ctx));
  value(await captions.readCaptions(INFO, ZH, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 2, "新结果记下了");
  assert.equal(fake.calls(NEW_FILE).length, 1, "用的是新地址");
});

test("fresh 碰上在途的列表请求时合并", async () => {
  const gate = deferred();
  const { captions, ctx, fake } = rig({
    [PLAYER_URL]: async () => {
      await gate.promise;
      return json(200, playerEnvelope([ZH_TRACK]));
    },
  });

  const first = captions.listCaptionTracks(INFO, ctx);
  await waitForCall(() => fake.calls(PLAYER_URL).length);
  const refreshed = captions.listCaptionTracks(INFO, ctx, { fresh: true });
  gate.resolve();

  assert.equal(value(await first).length, 1);
  assert.equal(value(await refreshed).length, 1);
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("文件失败后记录删掉，下一次列轨拿新地址", async () => {
  const failures: readonly (readonly [string, Route])[] = [
    ["拒绝访问", () => new Response("denied", { status: 403 })],
    ["服务端出错", () => new Response("oops", { status: 502 })],
    ["正文不是 JSON", htmlPage],
    ["正文带业务码", () => json(200, { code: -403, message: "sample refusal" })],
    ["请求抛错", () => Promise.reject(new TypeError("sample failure"))],
  ];
  for (const [label, broken] of failures) {
    const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: broken, [NEW_FILE]: oneLine() });
    value(await captions.listCaptionTracks(INFO, ctx));
    failure(await captions.readCaptions(INFO, ZH, ctx));
    assert.equal(fake.calls(PLAYER_URL).length, 1, `${label}：失败时不当场重列`);

    fake.routes.set(PLAYER_URL, listing(NEW_ZH_TRACK));
    value(await captions.listCaptionTracks(INFO, ctx));
    value(await captions.readCaptions(INFO, ZH, ctx));

    assert.equal(fake.calls(PLAYER_URL).length, 2, label);
    assert.equal(fake.calls(ZH_FILE).length, 1, label);
    assert.equal(fake.calls(NEW_FILE).length, 1, label);
  }
});

test("字幕文件被限流：报 RATE_LIMITED，不试下一条，不重列，记录留着", async () => {
  const { captions, ctx, fake, backoff } = rig({
    [PLAYER_URL]: listing(ZH_TRACK, EN_TRACK),
    [ZH_FILE]: () => new Response("sample refusal", { status: 429 }),
    [EN_FILE]: oneLine(),
  });
  value(await captions.listCaptionTracks(INFO, ctx));

  assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).code, "RATE_LIMITED");

  assert.equal(backoff.trips.length, 1);
  assert.equal(fake.calls(EN_FILE).length, 0);
  value(await captions.listCaptionTracks(INFO, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 1);

  // 退避期内连文件请求也不发。
  assert.equal(failure(await captions.readCaptions(INFO, EN, ctx)).code, "RATE_LIMITED");
  assert.equal(fake.calls(EN_FILE).length, 0);
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("字幕文件超时：报 TIMEOUT，记录留着，不重列", async () => {
  const { captions, ctx, fake, backoff } = rig(
    { [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: hanging },
    { requestTimeoutMs: 20 },
  );
  value(await captions.listCaptionTracks(INFO, ctx));

  assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).code, "TIMEOUT");

  assert.equal(backoff.trips.length, 0);
  value(await captions.listCaptionTracks(INFO, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("调用方取消下载时记录留着", async () => {
  const leaving = new AbortController();
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: hanging });
  value(await captions.listCaptionTracks(INFO, ctx));

  const reading = captions.readCaptions(INFO, ZH, { ...ctx, signal: leaving.signal });
  await waitForCall(() => fake.calls(ZH_FILE).length);
  leaving.abort();
  assert.equal((await reading).ok, false);

  value(await captions.listCaptionTracks(INFO, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("失败的 detail 里没有字幕地址", async () => {
  const routes: readonly Route[] = [
    () => new Response("denied", { status: 403 }),
    () => new Response("sample refusal", { status: 429 }),
    () => new Response("oops", { status: 502 }),
    htmlPage,
    () => json(200, { code: -400, message: "sample refusal" }),
    () => Promise.reject(new TypeError(`sample failure ${ZH_FILE}`)),
    hanging,
  ];
  for (const route of routes) {
    const { captions, ctx } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: route }, { requestTimeoutMs: 20 });
    const result = failure(await captions.readCaptions(INFO, ZH, ctx));
    assert.doesNotMatch(JSON.stringify(result), /hdslb|bfs|subtitle|zh\.json/);
  }

  const { captions, ctx } = rig({ [PLAYER_URL]: listing({ ...ZH_TRACK, subtitle_url: "//files.example.test/zh.json" }) });
  assert.doesNotMatch(JSON.stringify(failure(await captions.listCaptionTracks(INFO, ctx))), /example\.test/);
});

test("记录 5 分钟过期，过期后重新列", async () => {
  const { captions, ctx, fake, clock } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });
  value(await captions.listCaptionTracks(INFO, ctx));

  clock.at += RECORD_MS - 1;
  value(await captions.listCaptionTracks(INFO, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 1);

  clock.at += 1;
  value(await captions.listCaptionTracks(INFO, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 2);
});

test("换了视频、分 P 或媒体版本都不共用记录", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });
  const otherVideo: VideoInfo = { ...INFO, ref: { ...INFO.ref, videoId: "BV1Sample001" } };
  const secondPart: VideoInfo = { ...INFO, ref: { ...INFO.ref, segment: 2 }, mediaVersion: "2003" };
  const replaced: VideoInfo = { ...INFO, mediaVersion: "2004" };

  for (const info of [INFO, otherVideo, secondPart, replaced]) value(await captions.listCaptionTracks(info, ctx));

  assert.deepEqual(
    fake.calls(PLAYER_URL).map((request) => [request.query.get("bvid"), request.query.get("cid")]),
    [
      ["BV1Sample000", "2002"],
      ["BV1Sample001", "2002"],
      ["BV1Sample000", "2003"],
      ["BV1Sample000", "2004"],
    ],
  );
});

test("同时读同一视频只发一个列表请求", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine() });

  const [tracks, chapters, cues] = await Promise.all([
    captions.listCaptionTracks(INFO, ctx),
    captions.readCreatorChapters(INFO, ctx),
    captions.readCaptions(INFO, ZH, ctx),
  ]);

  assert.equal(value(tracks).length, 1);
  assert.deepEqual(value(chapters), []);
  assert.equal(value(cues).length, 1);
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("没有字幕的视频，同时读字幕轨和分段也只发一个列表请求", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing() });

  await Promise.all([captions.listCaptionTracks(INFO, ctx), captions.readCreatorChapters(INFO, ctx)]);

  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("在途的列表请求被一方取消，不连累另一方，也不中止请求", async () => {
  const gate = deferred();
  const { captions, ctx, fake } = rig({
    [PLAYER_URL]: async (request) => {
      await gate.promise;
      assert.equal(request.init.signal?.aborted, false);
      return json(200, playerEnvelope([ZH_TRACK]));
    },
  });
  const leaving = new AbortController();

  const first = captions.listCaptionTracks(INFO, { ...ctx, signal: leaving.signal });
  await waitForCall(() => fake.calls(PLAYER_URL).length);
  const second = captions.listCaptionTracks(INFO, ctx);
  leaving.abort();

  assert.equal(failure(await first).detail, "aborted");
  gate.resolve();
  assert.equal(value(await second).length, 1);
  assert.equal(fake.calls(PLAYER_URL).length, 1);

  value(await captions.listCaptionTracks(INFO, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 1, "请求跑完了，结果记下了");
});

test("调用方已经取消时不发列表请求", async () => {
  const { captions, ctx, fake, http } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });
  const cancelled = new AbortController();
  const leaving = { ...ctx, signal: cancelled.signal };
  value(await http.requireLogin(leaving));
  cancelled.abort();

  assert.equal(failure(await captions.listCaptionTracks(INFO, leaving)).detail, "aborted");

  assert.equal(fake.calls(PLAYER_URL).length, 0);
});

test("记录命中时也先过登录门", async () => {
  const { captions, ctx, fake, http } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine() });
  value(await captions.listCaptionTracks(INFO, ctx));
  http.forgetLogin();
  fake.routes.set(NAV_URL, () => json(200, navLoggedOut()));

  assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "NEED_LOGIN");
  assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).code, "NEED_LOGIN");
  assert.equal(failure(await captions.readCreatorChapters(INFO, ctx)).code, "NEED_LOGIN");

  assert.equal(fake.calls(ZH_FILE).length, 0);
});

test("记录命中时，新的读取操作也先确认登录", async () => {
  const { captions, ctx, fake, backoff } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine() });
  value(await captions.listCaptionTracks(INFO, ctx));

  value(await captions.listCaptionTracks(INFO, siteCtx(fake, backoff)));
  assert.equal(fake.calls(NAV_URL).length, 2, "新的操作重新确认");
  assert.equal(fake.calls(PLAYER_URL).length, 1, "列表用的是记录");

  fake.routes.set(NAV_URL, () => json(200, navLoggedOut()));
  assert.equal(failure(await captions.readCaptions(INFO, ZH, siteCtx(fake, backoff))).code, "NEED_LOGIN");
  assert.equal(failure(await captions.readCreatorChapters(INFO, siteCtx(fake, backoff))).code, "NEED_LOGIN");
  assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "NEED_LOGIN", "先前那次操作的结论也作废");

  assert.equal(fake.calls(ZH_FILE).length, 0);
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("没有媒体版本时不发列表请求，报 MALFORMED", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });
  const { mediaVersion: _mediaVersion, ...withoutVersion } = INFO;

  assert.equal(failure(await captions.listCaptionTracks(withoutVersion, ctx)).code, "MALFORMED");
  assert.equal(failure(await captions.readCaptions(withoutVersion, ZH, ctx)).code, "MALFORMED");

  assert.equal(fake.calls(PLAYER_URL).length, 0);
});

test("视频信息没带站内编号时不传这个参数，也不本地反算", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });
  const { siteRef: _siteRef, ...withoutRef } = INFO;

  value(await captions.listCaptionTracks(withoutRef, ctx));

  assert.equal(fake.calls(PLAYER_URL)[0]?.query.has("aid"), false);
});

test("调用方改列轨结果不影响记录", async () => {
  const { captions, ctx } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });

  value(await captions.listCaptionTracks(INFO, ctx)).length = 0;

  assert.equal(value(await captions.listCaptionTracks(INFO, ctx)).length, 1);
});
