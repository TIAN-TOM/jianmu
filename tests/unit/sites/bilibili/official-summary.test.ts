// 官方总结：请求走严格替身，响应都是自造的。
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { officialVerdictInputs } from "../../../../src/core/ai/verdict.ts";
import { learningAsMarkdown } from "../../../../src/core/notes/markdown.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { NAV_URL, PLAYER_URL, SUMMARY_URL, type BiliHttp, type GetRequest } from "../../../../src/sites/bilibili/http.ts";
import { parseOfficialSummary, readOfficialSummary } from "../../../../src/sites/bilibili/official-summary.ts";
import { INFO, playerEnvelope, rig, ZH_TRACK } from "../../../helpers/bilibili-captions.ts";
import { expectedSignature, failure, hanging, reachOf, signatureOf, value, type Route, type SeenRequest } from "../../../helpers/bilibili-fetch.ts";
import { BAN_RESPONSES, BVID, FIRST_KEYS, json, navLoggedIn, navLoggedOut, navWithoutKeys, SECOND_KEYS } from "../../../helpers/bilibili-fixtures.ts";

const REJECTED = { code: -352, message: "sample refusal" };
const VIDEO_BASE = "https://video.example/";
const PLAYER_OK = playerEnvelope([ZH_TRACK]);

function summaryData(): Record<string, unknown> {
  return {
    code: 0,
    stid: "1234",
    model_result: {
      summary: "一段关于番茄育苗的样例总结。",
      outline: [
        {
          title: "先选种子。",
          timestamp: 1,
          part_outline: [
            { timestamp: 1, content: "饱满的种子发芽快。" },
            { timestamp: 39, content: "温水泡一晚。" },
          ],
        },
        { title: "再说移栽。", timestamp: 241, part_outline: [{ timestamp: 241, content: "阴天移栽成活高。" }] },
      ],
      subtitle: [
        {
          part_subtitle: [
            { content: "今天聊聊种子", start_timestamp: 1, end_timestamp: 3 },
            { content: "大家好", start_timestamp: 0, end_timestamp: 1 },
            { content: "先看发芽率", start_timestamp: 3, end_timestamp: 5 },
          ],
        },
      ],
    },
  };
}

const summaryEnvelope = (): unknown => ({ code: 0, data: summaryData() });
const okSummary: Route = () => json(200, summaryEnvelope());

function noSummary(code: number, stid: unknown): Record<string, unknown> {
  return { code, stid, model_result: { summary: "", outline: [], subtitle: [] } };
}

const signedWith =
  (keys: typeof SECOND_KEYS) =>
  (request: SeenRequest): boolean =>
    signatureOf(request) === expectedSignature(request, keys);

// 账号接口按次序回，第一次之后的都换第二把密钥。
function rotatingNav(): Route {
  let calls = 0;
  return () => json(200, navLoggedIn(calls++ === 0 ? FIRST_KEYS : SECOND_KEYS));
}

// 先取到一次密钥，再把时钟拨过 60 秒；同一次操作不再确认登录。
async function warmKeys(setup: ReturnType<typeof rig>): Promise<void> {
  value(await setup.http.requireLogin(setup.ctx));
  setup.clock.at += 61_000;
}

test("官方总结 code 0：摘要、带时间戳的提纲和要点、AI 字幕都取出来", () => {
  const result = value(parseOfficialSummary(summaryData()));

  assert.equal(result.status, "ok");
  assert.match(result.summary, /番茄育苗/);
  assert.equal(result.outline.length, 2);
  assert.deepEqual(result.outline[0], {
    title: "先选种子。",
    timestamp: 1,
    points: [
      { timestamp: 1, content: "饱满的种子发芽快。" },
      { timestamp: 39, content: "温水泡一晚。" },
    ],
  });
  assert.equal(result.outline[1]?.timestamp, 241);
  assert.deepEqual(
    result.cues,
    [
      { text: "大家好", start: 0, duration: 1 },
      { text: "今天聊聊种子", start: 1, duration: 2 },
      { text: "先看发芽率", start: 3, duration: 2 },
    ],
    "摊平、按开始时间排好，和字幕正文同样的结构",
  );
});

test("规整后的提纲直接交给结论输入和学习稿，时间和要点都在", () => {
  const summary = value(parseOfficialSummary(summaryData()));

  assert.deepEqual(officialVerdictInputs(summary).chaptersText.split("\n"), [
    "全片概述：一段关于番茄育苗的样例总结。",
    "[0:01] 先选种子。：饱满的种子发芽快。；温水泡一晚。",
    "[4:01] 再说移栽。：阴天移栽成活高。",
  ]);

  const lines = learningAsMarkdown({ videoKey: videoKey(INFO.ref), officialSummary: summary }, VIDEO_BASE).split("\n");
  const link = (stamp: string, seconds: number): string => `[${stamp}](${VIDEO_BASE}${BVID}?t=${seconds})`;
  for (const line of [
    `### ${link("0:01", 1)} 先选种子。`,
    `- ${link("0:01", 1)} 饱满的种子发芽快。`,
    `- ${link("0:39", 39)} 温水泡一晚。`,
    `### ${link("4:01", 241)} 再说移栽。`,
    `- ${link("4:01", 241)} 阴天移栽成活高。`,
  ]) {
    assert.ok(lines.includes(line), line);
  }
});

test('官方总结 code 1：stid 为 "0" 是排进了生成队列，为空是没识别到语音', () => {
  const queued = value(parseOfficialSummary(noSummary(1, "0")));
  assert.equal(queued.status, "queued");
  assert.equal(queued.summary, "");
  assert.deepEqual(queued.outline, []);
  assert.deepEqual(queued.cues, []);

  assert.equal(value(parseOfficialSummary(noSummary(1, 0))).status, "queued", "数字 0 也算排队");
  assert.equal(value(parseOfficialSummary(noSummary(1, ""))).status, "none");
  assert.equal(value(parseOfficialSummary(noSummary(1, null))).status, "none");
});

test("官方总结 code -1：不支持，和「没有」分开记", () => {
  assert.equal(value(parseOfficialSummary(noSummary(-1, ""))).status, "unsupported");
});

test("外层 -101 报 NEED_LOGIN；其余外层错误码报 MALFORMED，detail 留下原码", async () => {
  const loggedOut = rig({ [SUMMARY_URL]: () => json(200, { code: -101, message: "sample refusal" }) });
  const login = failure(await readOfficialSummary(loggedOut.http, INFO, loggedOut.ctx));
  assert.equal(login.code, "NEED_LOGIN");
  assert.equal(login.detail, "code:-101");

  const denied = rig({ [SUMMARY_URL]: () => json(200, { code: -400, message: "sample refusal" }) });
  const other = failure(await readOfficialSummary(denied.http, INFO, denied.ctx));
  assert.equal(other.code, "MALFORMED");
  assert.equal(other.detail, "code:-400");
});

test("字段缺失：缺 data、缺 model_result、空内容、缺时间戳都不出错", async () => {
  for (const body of [null, "oops", { code: 0 }]) {
    const { http, ctx } = rig({ [SUMMARY_URL]: () => json(200, body) });
    assert.equal(failure(await readOfficialSummary(http, INFO, ctx)).code, "MALFORMED", JSON.stringify(body));
  }

  const bare = value(parseOfficialSummary({ code: 0 }));
  assert.equal(bare.status, "none", "code 0 但什么都没有，不能当成有总结");
  assert.deepEqual(bare.cues, []);

  const partial = value(
    parseOfficialSummary({
      code: 0,
      model_result: {
        summary: "  ",
        outline: [
          { title: "第一段", part_outline: [{ content: "无时间要点" }, { timestamp: 12, content: "要点" }] },
          { title: "第二段", timestamp: null, part_outline: [{ timestamp: null, content: "也没时间" }] },
          { title: "", part_outline: [{ timestamp: 3, content: "  " }] },
          "不是对象",
        ],
        subtitle: [{ part_subtitle: [{ content: "缺开始" }, { content: "有开始", start_timestamp: 4 }] }, null],
      },
    }),
  );

  assert.equal(partial.status, "ok", "只有提纲也算有总结");
  assert.equal(partial.summary, "");
  assert.equal(partial.outline.length, 2, "标题和要点都空的分段丢掉");
  assert.equal(partial.outline[0]?.timestamp, 12, "分段没有时间，退到第一条带时间的要点");
  assert.deepEqual(partial.outline[0]?.points[0], { timestamp: null, content: "无时间要点" });
  assert.equal(partial.outline[1]?.timestamp, null, "空值不能变成 0");
  assert.deepEqual(partial.cues, [{ text: "有开始", start: 4, duration: 0 }]);
});

test("请求带请求签名、bvid、cid 和 up_mid，并带上登录 cookie", async () => {
  const { http, ctx, fake } = rig({ [SUMMARY_URL]: okSummary });

  const result = value(await readOfficialSummary(http, INFO, ctx));

  assert.equal(result.status, "ok");
  const [seen] = fake.calls(SUMMARY_URL);
  assert.ok(seen);
  assert.equal(seen.query.get("bvid"), BVID);
  assert.equal(seen.query.get("cid"), "2002");
  assert.equal(seen.query.get("up_mid"), "3003");
  assert.equal(seen.query.has("aid"), false);
  assert.ok(seen.query.get("wts"));
  assert.equal(signatureOf(seen), expectedSignature(seen, FIRST_KEYS));
  assert.equal(seen.init.credentials, "include");
  assert.equal(seen.init.cache, "no-store");
});

test("没有 UP 主 mid 时不带 up_mid", async () => {
  const { channel: _channel, ...withoutChannel } = INFO;
  const { http, ctx, fake } = rig({ [SUMMARY_URL]: () => json(200, { code: 0, data: noSummary(1, "") }) });

  value(await readOfficialSummary(http, withoutChannel, ctx));

  const [seen] = fake.calls(SUMMARY_URL);
  assert.ok(seen);
  assert.equal(seen.query.has("up_mid"), false);
  assert.equal(seen.query.get("cid"), "2002");
});

test("网络失败、HTTP 错误、坏 JSON、取不到签名密钥都按 SiteResult 报，不抛错", async () => {
  const dropped = rig({
    [SUMMARY_URL]: () => {
      throw new TypeError("sample failure");
    },
  });
  assert.equal(failure(await readOfficialSummary(dropped.http, INFO, dropped.ctx)).code, "NETWORK");

  const broken = rig({ [SUMMARY_URL]: () => json(503, {}) });
  const http = failure(await readOfficialSummary(broken.http, INFO, broken.ctx));
  assert.equal(http.code, "NETWORK");
  assert.equal(http.detail, "http:503");
  assert.equal(broken.backoff.trips.length, 0, "普通的 HTTP 错误不进退避");

  const badJson = rig({ [SUMMARY_URL]: () => new Response("{", { status: 200 }) });
  assert.equal(failure(await readOfficialSummary(badJson.http, INFO, badJson.ctx)).code, "MALFORMED");
  assert.equal(badJson.backoff.trips.length, 1, "接口主机回的不是 JSON 要进退避");

  const noKeys = rig({ [NAV_URL]: () => json(200, navWithoutKeys()) });
  const keys = failure(await readOfficialSummary(noKeys.http, INFO, noKeys.ctx));
  assert.equal(keys.code, "MALFORMED");
  assert.equal(noKeys.fake.calls(SUMMARY_URL).length, 0, "拿不到密钥就不发总结请求");

  const navDown = rig({ [NAV_URL]: () => json(503, {}) });
  assert.equal(failure(await readOfficialSummary(navDown.http, INFO, navDown.ctx)).code, "NETWORK");
  assert.equal(navDown.fake.calls(SUMMARY_URL).length, 0);
});

test("迟迟不回时按时放手，报 TIMEOUT，并中止请求", async () => {
  const { http, ctx, fake } = rig({ [SUMMARY_URL]: hanging });

  const result = failure(await readOfficialSummary(http, INFO, ctx, { timeoutMs: 20 }));

  assert.equal(result.code, "TIMEOUT");
  assert.equal(fake.calls(SUMMARY_URL)[0]?.init.signal?.aborted, true);
});

test("8 秒预算只算官方总结那一个请求：签名密钥（nav）慢不占它的时间", async () => {
  const slowNav: Route = async () => {
    await delay(250);
    return json(200, navLoggedIn());
  };
  const { http, ctx } = rig({ [NAV_URL]: slowNav, [SUMMARY_URL]: okSummary });

  const result = value(await readOfficialSummary(http, INFO, ctx, { timeoutMs: 150 }));

  assert.equal(result.status, "ok");
  assert.ok(result.cues.length > 0, "附带字幕照样带回");
});

test("签名密钥自己超时（nav 有自己的时限）：报 TIMEOUT，不挂住", async () => {
  const { http, ctx, fake } = rig({ [NAV_URL]: hanging }, { requestTimeoutMs: 20 });

  assert.equal(failure(await readOfficialSummary(http, INFO, ctx)).code, "TIMEOUT");
  assert.equal(fake.calls(SUMMARY_URL).length, 0);
});

test("缺 cid 时不发请求", async () => {
  const { mediaVersion: _mediaVersion, ...withoutCid } = INFO;
  const { http, ctx, fake } = rig({});

  const result = failure(await readOfficialSummary(http, withoutCid, ctx));

  assert.equal(result.code, "MALFORMED");
  assert.equal(result.detail, "no-media-version");
  assert.equal(fake.requests.length, 0);
});

test("签名密钥（nav）一直不回：官方总结先发起、字幕列表跟着等同一个请求，两边都按时放手", async () => {
  const { http, captions, ctx, fake } = rig({ [NAV_URL]: hanging }, { requestTimeoutMs: 40 });

  const [summary, tracks] = await Promise.all([
    readOfficialSummary(http, INFO, ctx, { timeoutMs: 10_000 }),
    captions.listCaptionTracks(INFO, ctx),
  ]);

  assert.equal(fake.calls(NAV_URL).length, 1, "两边共用一次账号请求");
  assert.equal(failure(summary).code, "TIMEOUT");
  assert.equal(failure(tracks).code, "TIMEOUT");
});

test("官方总结：旧密钥回 -352，换一次密钥重发拿到总结；仍是 -352 时记限流", async () => {
  const renewed = rig({
    [NAV_URL]: rotatingNav(),
    [SUMMARY_URL]: (request) => (signedWith(SECOND_KEYS)(request) ? json(200, summaryEnvelope()) : json(200, REJECTED)),
  });
  await warmKeys(renewed);
  assert.equal(value(await readOfficialSummary(renewed.http, INFO, renewed.ctx)).status, "ok");
  assert.equal(renewed.fake.calls(NAV_URL).length, 2);
  assert.equal(renewed.fake.calls(SUMMARY_URL).length, 2);
  assert.equal(renewed.backoff.trips.length, 0);

  const refused = rig({ [NAV_URL]: rotatingNav(), [SUMMARY_URL]: () => json(200, REJECTED) });
  await warmKeys(refused);
  assert.equal(failure(await readOfficialSummary(refused.http, INFO, refused.ctx)).code, "RATE_LIMITED");
  assert.equal(refused.fake.calls(NAV_URL).length, 2);
  assert.equal(refused.fake.calls(SUMMARY_URL).length, 2, "最多重发一次");
  assert.equal(refused.backoff.trips.length, 1);
});

test("字幕列表和官方总结同时撞上 -352：nav 只重取一次", async () => {
  const signedNew = signedWith(SECOND_KEYS);
  const setup = rig({
    [NAV_URL]: rotatingNav(),
    [PLAYER_URL]: (request) => (signedNew(request) ? json(200, PLAYER_OK) : json(200, REJECTED)),
    [SUMMARY_URL]: (request) => (signedNew(request) ? json(200, summaryEnvelope()) : json(200, REJECTED)),
  });
  await warmKeys(setup);

  const [tracks, summary] = await Promise.all([
    setup.captions.listCaptionTracks(INFO, setup.ctx),
    readOfficialSummary(setup.http, INFO, setup.ctx),
  ]);

  assert.equal(value(tracks).length, 1);
  assert.equal(value(summary).status, "ok");
  assert.equal(setup.fake.calls(NAV_URL).length, 2);
});

for (const [label, ban] of BAN_RESPONSES) {
  test(`官方总结：${label} 时报 RATE_LIMITED`, async () => {
    const { http, ctx, fake, backoff } = rig({ [SUMMARY_URL]: ban });

    assert.equal(failure(await readOfficialSummary(http, INFO, ctx)).code, "RATE_LIMITED");

    assert.equal(backoff.trips.length, 1);
    assert.equal(fake.calls(SUMMARY_URL).length, 1, "不重发");
  });

  test(`官方总结：取签名密钥时就被拦（${label}）也归为 RATE_LIMITED`, async () => {
    const { http, ctx, fake, backoff } = rig({ [NAV_URL]: ban });

    assert.equal(failure(await readOfficialSummary(http, INFO, ctx)).code, "RATE_LIMITED");

    assert.equal(backoff.trips.length, 1);
    assert.equal(fake.calls(NAV_URL).length, 1, "不重发");
    assert.equal(fake.calls(SUMMARY_URL).length, 0);
  });
}

test("账号接口回未登录时不发官方总结请求", async () => {
  const { http, ctx, fake } = rig({ [NAV_URL]: () => json(200, navLoggedOut()) });

  assert.equal(failure(await readOfficialSummary(http, INFO, ctx)).code, "NEED_LOGIN");

  assert.equal(fake.calls(SUMMARY_URL).length, 0);
});

test("不认识的内容状态报 MALFORMED，不当成没有总结", () => {
  const strange = failure(parseOfficialSummary(noSummary(7, "")));
  assert.equal(strange.code, "MALFORMED");
  assert.equal(strange.detail, "summary-code:7");

  assert.equal(failure(parseOfficialSummary({ stid: "1234" })).detail, "no-summary-code");
});

test("官方总结读不懂只影响这一个视频：内层错误码、缺码、数据不是对象、缺媒体版本都标 item", async () => {
  for (const data of [noSummary(7, ""), { stid: "1234" }, null, "oops"]) {
    assert.equal(failure(parseOfficialSummary(data)).code, "MALFORMED", JSON.stringify(data));
    assert.equal(reachOf(parseOfficialSummary(data)), "item", JSON.stringify(data));
  }

  const empty = rig({ [SUMMARY_URL]: () => json(200, { code: 0 }) });
  assert.equal(reachOf(await readOfficialSummary(empty.http, INFO, empty.ctx)), "item", "信封里没有数据");

  const { mediaVersion: _mediaVersion, ...withoutVersion } = INFO;
  const unversioned = rig({ [SUMMARY_URL]: okSummary });
  assert.equal(reachOf(await readOfficialSummary(unversioned.http, withoutVersion, unversioned.ctx)), "item");
  assert.equal(unversioned.fake.calls(SUMMARY_URL).length, 0);
});

test("没有总结只有附带字幕时报没有总结，字幕照样带回", () => {
  const result = value(
    parseOfficialSummary({
      code: 0,
      model_result: { subtitle: [{ part_subtitle: [{ content: "样例台词", start_timestamp: 1, end_timestamp: 2 }] }] },
    }),
  );

  assert.equal(result.status, "none");
  assert.deepEqual(result.cues, [{ text: "样例台词", start: 1, duration: 1 }]);
});

test("官方总结默认的时限是 8 秒", async () => {
  const { http, ctx } = rig({ [SUMMARY_URL]: okSummary });
  const seen: GetRequest[] = [];
  const spying: BiliHttp = {
    ...http,
    getData: (request, requestCtx) => {
      seen.push(request);
      return http.getData(request, requestCtx);
    },
  };

  value(await readOfficialSummary(spying, INFO, ctx));

  assert.equal(seen[0]?.timeoutMs, 8_000);
});
