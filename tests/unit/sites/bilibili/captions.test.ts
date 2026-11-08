// 字幕轨、字幕正文和 UP 主分段：请求走严格替身，响应都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { pickTrack } from "../../../../src/core/transcript/pick-track.ts";
import { parseChapters, parseCues } from "../../../../src/sites/bilibili/captions.ts";
import { NAV_URL, PLAYER_URL } from "../../../../src/sites/bilibili/http.ts";
import type { CaptionTrack } from "../../../../src/sites/types.ts";
import { EN_TRACK, INFO, listing, oneLine, playerEnvelope, rig, ZH_FILE, ZH_TRACK } from "../../../helpers/bilibili-captions.ts";
import { expectedSignature, failure, reachOf, signatureOf, value, type Route, type SeenRequest } from "../../../helpers/bilibili-fetch.ts";
import { BVID, FIRST_KEYS, json, navLoggedIn, navLoggedOut, SECOND_KEYS } from "../../../helpers/bilibili-fixtures.ts";

const ZH: CaptionTrack = { trackId: "zh-CN", lang: "zh-CN", label: "中文（中国）", kind: "human" };
const REJECTED = { code: -352, message: "sample refusal" };
const PLAYER_OK = playerEnvelope([ZH_TRACK]);
const htmlPage: Route = () => new Response("<!DOCTYPE html><html>请先登录网络</html>", { status: 200 });

const langsOf = (tracks: readonly CaptionTrack[]): string[] => tracks.map((track) => track.lang);
const pathsOf = (requests: readonly SeenRequest[]): string[] => requests.map((request) => new URL(request.url).pathname);

function seqNav(...bodies: readonly unknown[]): Route {
  let calls = 0;
  return () => json(200, bodies[Math.min(calls++, bodies.length - 1)]);
}

// 先取到一次密钥，再把时钟拨过 60 秒；同一次操作不再确认登录。
async function warmKeys(setup: ReturnType<typeof rig>): Promise<void> {
  value(await setup.http.requireLogin(setup.ctx));
  setup.clock.at += 61_000;
}

test("字幕轨补全协议头并识别 AI 字幕", async () => {
  const human = "https://i0.hdslb.com/bfs/subtitle/abc.json";
  const generated = "https://aisubtitle.hdslb.com/bfs/subtitle/def.json";
  const { captions, ctx, fake } = rig({
    [PLAYER_URL]: listing(
      { id: 1, lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "//i0.hdslb.com/bfs/subtitle/abc.json" },
      {
        id: 2,
        lan: "ai-zh",
        lan_doc: "中文（自动生成）",
        subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/def.json",
        ai_status: 2,
        ai_type: 0,
      },
      { id: 3, lan: "en-US", lan_doc: "英语", subtitle_url: "" },
    ),
    [human]: oneLine(),
    [generated]: oneLine(),
  });

  const tracks = value(await captions.listCaptionTracks(INFO, ctx));

  assert.equal(tracks.length, 2, "没有地址的轨被丢掉");
  assert.deepEqual(
    tracks.map((track) => [track.trackId, track.label, track.kind]),
    [
      ["zh-CN", "中文（中国）", "human"],
      ["ai-zh", "中文（自动生成）", "auto"],
    ],
  );
  for (const track of tracks) value(await captions.readCaptions(INFO, track, ctx));
  assert.deepEqual(
    fake.requests.slice(-2).map((request) => request.url),
    [human, generated],
  );
});

test("没有字幕字段时返回空列表而不是抛错", async () => {
  for (const body of [{ code: 0, data: {} }, { code: 0, data: null }, { code: 0 }, { code: 0, data: { subtitle: null } }]) {
    const { captions, ctx, fake } = rig({ [PLAYER_URL]: () => json(200, body) });
    assert.deepEqual(value(await captions.listCaptionTracks(INFO, ctx)), []);
    assert.equal(fake.calls(PLAYER_URL).length, 1, "空列表只发这一次请求，不换别的路线");
  }
});

test("同一文件的中文（中国）合并掉，不同文件的两条中文都保留", async () => {
  const list = async (...subtitles: readonly unknown[]): Promise<string[]> => {
    const { captions, ctx } = rig({ [PLAYER_URL]: listing(...subtitles) });
    return langsOf(value(await captions.listCaptionTracks(INFO, ctx)));
  };
  const track = (lan: string, lan_doc: string, path: string): unknown => ({
    lan,
    lan_doc,
    subtitle_url: `https://i0.hdslb.com/bfs/subtitle/${path}`,
  });

  assert.deepEqual(
    await list(
      track("zh-Hans", "中文（简体）", "zh.json"),
      track("zh-CN", "中文（中国）", "alias.json"),
      track("en", "English", "en.json"),
      track("en-US", "English(US)", "en-us.json"),
    ),
    ["zh-Hans", "zh-CN", "en", "en-US"],
  );

  assert.deepEqual(
    await list(track("zh-Hans", "中文（简体）", "empty.json"), track("en-US", "English(US)", "empty.json?sample=2")),
    ["zh-Hans", "en-US"],
    "不同语种共用一个占位文件时不互相吞掉",
  );

  assert.deepEqual(await list(track("zh-CN", "中文（中国）", "only.json")), ["zh-CN"]);

  assert.deepEqual(
    await list(track("zh-CN", "中文（中国）", "a.json?sample=1"), track("zh-Hans", "中文（简体）", "a.json")),
    ["zh-Hans"],
  );
});

test("字幕正文转成 {text, start, duration}", () => {
  const cues = parseCues({
    body: [
      { from: 0, to: 2.5, content: "第一句" },
      { from: 2.5, to: 5, content: "  第二句  " },
      { from: 5, to: 6, content: "   " },
      { from: 6, to: 6, content: "零时长" },
    ],
  });

  assert.equal(cues.length, 3, "空白字幕行丢掉");
  assert.deepEqual(cues[0], { text: "第一句", start: 0, duration: 2.5 });
  assert.equal(cues[1]?.text, "第二句");
  assert.equal(cues[2]?.duration, 0);
});

test("字幕正文缺失时返回空数组", async () => {
  assert.deepEqual(parseCues({}), []);
  assert.deepEqual(parseCues(null), []);

  const { captions, ctx, backoff } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: () => json(200, {}) });
  assert.deepEqual(value(await captions.readCaptions(INFO, ZH, ctx)), [], "空文件由取字幕服务判断");
  assert.equal(backoff.trips.length, 0);
});

test("字幕列表请求带请求签名", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK) });

  value(await captions.listCaptionTracks(INFO, ctx));

  const [seen] = fake.calls(PLAYER_URL);
  assert.ok(seen);
  assert.equal(seen.query.get("aid"), "1001", "取视频信息带来的编号，不本地反算");
  assert.equal(seen.query.get("cid"), "2002");
  assert.equal(seen.query.get("bvid"), BVID);
  assert.ok(seen.query.get("wts"));
  assert.equal(signatureOf(seen), expectedSignature(seen, FIRST_KEYS));
  assert.equal(seen.init.credentials, "include");
});

test("未登录导致字幕不可见时能与「真的没字幕」区分开", async () => {
  for (const subtitles of [[], [ZH_TRACK]]) {
    const body = playerEnvelope(subtitles, { need_login_subtitle: true });
    const { captions, ctx, fake } = rig({ [PLAYER_URL]: () => json(200, body) });

    assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "NEED_LOGIN");

    const asked = fake.calls(NAV_URL).length;
    assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "NEED_LOGIN");
    assert.equal(fake.calls(NAV_URL).length, asked + 1, "已登录记录清掉了，下次重新确认");
  }

  const { captions, ctx } = rig({ [PLAYER_URL]: () => json(200, playerEnvelope([], { need_login_subtitle: false })) });
  assert.deepEqual(value(await captions.listCaptionTracks(INFO, ctx)), []);
});

test("字幕文件下载不携带 cookie", async () => {
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: oneLine("hi") });

  const cues = value(await captions.readCaptions(INFO, ZH, ctx));

  const [seen] = fake.calls(ZH_FILE);
  assert.ok(seen);
  assert.equal(seen.init.credentials, "omit");
  assert.equal(seen.init.cache, "default");
  assert.equal(cues[0]?.text, "hi");
});

test("字幕文件下载失败给出可识别的错误码", async () => {
  const { captions, ctx, backoff } = rig({
    [PLAYER_URL]: listing(ZH_TRACK),
    [ZH_FILE]: () => new Response("denied", { status: 403 }),
  });

  const result = failure(await captions.readCaptions(INFO, ZH, ctx));

  assert.equal(result.code, "NETWORK");
  assert.equal(result.detail, "http:403");
  assert.equal(backoff.trips.length, 0, "多半是地址过期，不进退避");
});

test("未登录时不读字幕，报 NEED_LOGIN", async () => {
  const { captions, ctx, fake } = rig({
    [NAV_URL]: () => json(200, navLoggedOut()),
    [PLAYER_URL]: listing(ZH_TRACK),
    [ZH_FILE]: oneLine(),
  });

  assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "NEED_LOGIN");
  assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).code, "NEED_LOGIN");
  assert.equal(failure(await captions.readCreatorChapters(INFO, ctx)).code, "NEED_LOGIN");

  assert.deepEqual([...new Set(fake.requests.map((request) => request.endpoint))], [NAV_URL], "内容请求一个都不发");
});

test("字幕 JSON 的业务码不当成空字幕", async () => {
  for (const [code, expected] of [
    [-403, "UNPLAYABLE"],
    [-101, "NEED_LOGIN"],
    [-412, "RATE_LIMITED"],
    [-400, "MALFORMED"],
  ] as const) {
    const { captions, ctx } = rig({
      [PLAYER_URL]: listing(ZH_TRACK),
      [ZH_FILE]: () => json(200, { code, message: "sample refusal" }),
    });
    assert.equal(failure(await captions.readCaptions(INFO, ZH, ctx)).code, expected);
  }
});

// UP 主分段的样例只留用得到的字段。
const point = (from: unknown, to: unknown, content: unknown): unknown => ({ type: 2, from, to, content });

test("UP 主分段：取标题和起止秒数，按开始时间排好", () => {
  const chapters = parseChapters({
    view_points: [point(95, 300.5, "正题"), point(0, 95, "开场"), point(300.5, 300.5, "  结尾  ")],
  });
  assert.deepEqual(chapters, [
    { title: "开场", start: 0, end: 95 },
    { title: "正题", start: 95, end: 300.5 },
    { title: "结尾", start: 300.5, end: null },
  ]);
});

test("UP 主分段：没有章节、字段缺失或坏数据时不出错", () => {
  assert.deepEqual(parseChapters({ view_points: [] }), []);
  assert.deepEqual(parseChapters({}), []);
  assert.deepEqual(parseChapters(null), []);
  assert.deepEqual(parseChapters({ view_points: "坏数据" }), []);
  assert.deepEqual(
    parseChapters({
      view_points: [{ content: "缺起点", to: 10 }, { from: null, content: "起点为空" }, { from: -1, content: "负数" }, { from: 5 }, null],
    }),
    [{ title: "", start: 5, end: null }],
  );
});

test("字幕列表请求顺带带回 UP 主分段，不多发请求", async () => {
  const body = playerEnvelope([ZH_TRACK], { view_points: [point(0, 30, "开场")] });
  const { captions, ctx, fake } = rig({ [PLAYER_URL]: () => json(200, body) });

  assert.equal(value(await captions.listCaptionTracks(INFO, ctx)).length, 1);
  assert.deepEqual(value(await captions.readCreatorChapters(INFO, ctx)), [{ title: "开场", start: 0, end: 30 }]);

  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("字幕列表返回的不是 JSON：同样报 MALFORMED", async () => {
  const { captions, ctx, backoff } = rig({ [PLAYER_URL]: htmlPage });

  const result = failure(await captions.listCaptionTracks(INFO, ctx));

  assert.equal(result.code, "MALFORMED");
  assert.doesNotMatch(result.detail ?? "", /JSON|Unexpected/);
  assert.equal(backoff.trips.length, 1, "批次靠退避停下");
});

test("字幕文件返回的不是 JSON：报 MALFORMED", async () => {
  const { captions, ctx, backoff } = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: htmlPage });

  const result = failure(await captions.readCaptions(INFO, ZH, ctx));

  assert.equal(result.code, "MALFORMED");
  assert.doesNotMatch(result.detail ?? "", /JSON|Unexpected/);
  assert.equal(backoff.trips.length, 0);
});

test("字幕读不懂只影响这一个视频：没有可用地址、缺媒体版本、字幕文件读不懂都标 item", async () => {
  const unusable = playerEnvelope([{ ...ZH_TRACK, subtitle_url: "//files.example.test/zh.json" }]);
  const noUrl = rig({ [PLAYER_URL]: () => json(200, unusable) });
  assert.equal(reachOf(await noUrl.captions.listCaptionTracks(INFO, noUrl.ctx)), "item");
  assert.equal(reachOf(await noUrl.captions.readCaptions(INFO, ZH, noUrl.ctx)), "item");

  const { mediaVersion: _mediaVersion, ...withoutVersion } = INFO;
  const unversioned = rig({ [PLAYER_URL]: listing(ZH_TRACK) });
  assert.equal(reachOf(await unversioned.captions.listCaptionTracks(withoutVersion, unversioned.ctx)), "item");
  assert.equal(reachOf(await unversioned.captions.readCaptions(withoutVersion, ZH, unversioned.ctx)), "item");

  for (const file of [htmlPage, () => json(200, { code: -400 })]) {
    const broken = rig({ [PLAYER_URL]: listing(ZH_TRACK), [ZH_FILE]: file });
    assert.equal(reachOf(await broken.captions.readCaptions(INFO, ZH, broken.ctx)), "item");
  }
});

test("字幕列表读不懂时标 source：响应不是 JSON 或没有业务码", async () => {
  for (const reply of [htmlPage, () => json(200, { data: {} })]) {
    const { captions, ctx } = rig({ [PLAYER_URL]: reply });
    assert.equal(reachOf(await captions.listCaptionTracks(INFO, ctx)), "source");
  }
});

test("字幕列表被限流（HTTP 429）：报限流，不自动重发，也不换备用接口再问一遍", async () => {
  const { captions, ctx, fake, backoff } = rig({
    [PLAYER_URL]: () => new Response("sample refusal", { status: 429 }),
  });

  assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "RATE_LIMITED");

  assert.equal(backoff.trips.length, 1);
  assert.deepEqual(pathsOf(fake.requests), ["/x/web-interface/nav", "/x/player/wbi/v2"]);
});

test("字幕列表：旧密钥回 -352，换一次密钥重发成功", async () => {
  const setup = rig({
    [NAV_URL]: seqNav(navLoggedIn(FIRST_KEYS), navLoggedIn(SECOND_KEYS)),
    [PLAYER_URL]: (request) =>
      json(200, signatureOf(request) === expectedSignature(request, SECOND_KEYS) ? PLAYER_OK : REJECTED),
  });
  await warmKeys(setup);

  const tracks = value(await setup.captions.listCaptionTracks(INFO, setup.ctx));

  assert.equal(tracks.length, 1);
  assert.equal(setup.fake.calls(NAV_URL).length, 2);
  assert.equal(setup.fake.calls(PLAYER_URL).length, 2);
  assert.equal(setup.backoff.trips.length, 0);
});

test("字幕列表：换了密钥还是 -352，报限流，不再重发", async () => {
  const setup = rig({
    [NAV_URL]: seqNav(navLoggedIn(FIRST_KEYS), navLoggedIn(SECOND_KEYS)),
    [PLAYER_URL]: () => json(200, REJECTED),
  });
  await warmKeys(setup);

  assert.equal(failure(await setup.captions.listCaptionTracks(INFO, setup.ctx)).code, "RATE_LIMITED");
  assert.equal(setup.fake.calls(NAV_URL).length, 2);
  assert.equal(setup.fake.calls(PLAYER_URL).length, 2);
  assert.equal(setup.backoff.trips.length, 1);

  // 退避到期后的下一次：刚换过的密钥不到 60 秒，再被拒也不再换。
  setup.backoff.blockedSec = 0;
  assert.equal(failure(await setup.captions.listCaptionTracks(INFO, setup.ctx)).code, "RATE_LIMITED");
  assert.equal(setup.fake.calls(NAV_URL).length, 2);
  assert.equal(setup.fake.calls(PLAYER_URL).length, 3);
});

test("密钥刚取到（不到 60 秒）就回 -352：不是密钥过期，不换不重发", async () => {
  const { captions, ctx, fake } = rig({
    [NAV_URL]: seqNav(navLoggedIn(FIRST_KEYS), navLoggedIn(SECOND_KEYS)),
    [PLAYER_URL]: () => json(200, REJECTED),
  });

  assert.equal(failure(await captions.listCaptionTracks(INFO, ctx)).code, "RATE_LIMITED");

  assert.equal(fake.calls(NAV_URL).length, 1);
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("nav 重取到的还是原来那把密钥：不重发，照常报限流", async () => {
  const setup = rig({ [PLAYER_URL]: () => json(200, REJECTED) });
  await warmKeys(setup);

  assert.equal(failure(await setup.captions.listCaptionTracks(INFO, setup.ctx)).code, "RATE_LIMITED");

  assert.equal(setup.fake.calls(NAV_URL).length, 2);
  assert.equal(setup.fake.calls(PLAYER_URL).length, 1);
});

test("其他限流码（-412）不换密钥", async () => {
  const setup = rig({
    [NAV_URL]: seqNav(navLoggedIn(FIRST_KEYS), navLoggedIn(SECOND_KEYS)),
    [PLAYER_URL]: () => json(200, { code: -412, message: "sample refusal" }),
  });
  await warmKeys(setup);

  assert.equal(failure(await setup.captions.listCaptionTracks(INFO, setup.ctx)).code, "RATE_LIMITED");

  assert.equal(setup.fake.calls(NAV_URL).length, 1);
  assert.equal(setup.fake.calls(PLAYER_URL).length, 1);
});

// owned 给轨记上上传者，默认是这个视频的 UP 主；ZH_AI 是一条中文自动字幕。
const owned = (track: object, author_mid = 3003): object => ({ ...track, author_mid });
const ZH_AI = { lan: "ai-zh", lan_doc: "中文（自动生成）", subtitle_url: "//aisubtitle.hdslb.com/bfs/subtitle/ai.json", ai_status: 2 };

async function listed(...subtitles: readonly unknown[]): Promise<CaptionTrack[]> {
  const { captions, ctx } = rig({ [PLAYER_URL]: listing(...subtitles) });
  return value(await captions.listCaptionTracks(INFO, ctx));
}

test("字幕轨不标原语言：UP 主只传了一种语言也不标", async () => {
  for (const subtitles of [
    [ZH_TRACK, owned(EN_TRACK)],
    [owned(ZH_TRACK), owned(EN_TRACK)],
    [ZH_TRACK, EN_TRACK],
    [owned(ZH_TRACK, 4004)],
    [owned(ZH_AI), owned(EN_TRACK)],
    [owned(ZH_AI)],
  ]) {
    const tracks = await listed(...subtitles);
    assert.ok(tracks.length > 0);
    assert.deepEqual(tracks.filter((track) => "isOriginalLang" in track), [], "这个标记不设，连 false 也不写");
  }
});

test("只有英文人工字幕和中文自动字幕：不标原语言，默认选英文人工轨", async () => {
  const tracks = await listed(owned(EN_TRACK), owned(ZH_AI));

  assert.deepEqual(
    tracks.map((track) => [track.lang, track.kind, track.isOriginalLang]),
    [
      ["en-US", "human", undefined],
      ["ai-zh", "auto", undefined],
    ],
  );
  // 两条都不算原语言、也没有中文人工：同一档里人工在自动之前，选中英文人工轨。
  assert.equal(pickTrack(tracks, INFO.audioLang)?.trackId, "en-US");

  // UP 主只传了英文、别人传了中文：同样不标，中文人工排在前面。
  const withZh = await listed(owned(ZH_TRACK, 4004), owned(EN_TRACK), owned(ZH_AI));
  assert.equal(pickTrack(withZh, INFO.audioLang)?.trackId, "zh-CN");
});
