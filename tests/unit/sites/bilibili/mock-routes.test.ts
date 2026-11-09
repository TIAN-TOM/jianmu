// 真实读取实现对着端到端的模拟路由走一遍：Chrome 里的真实链路要等后台路由接上，这里先核对两边对得上。
import assert from "node:assert/strict";
import { test } from "node:test";
import { FIRST_VIDEO, KEYS, ROTATED_KEYS, SECOND_VIDEO } from "../../../../e2e/fixtures.mjs";
import { hostRulesFor, PROBE, route, slowed } from "../../../../e2e/mock-server.mjs";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import { createSiteBackoff } from "../../../../src/platform/site-backoff.ts";
import { PLAYER_URL, SUMMARY_URL, VIEW_URL, WATCH_LATER_URL } from "../../../../src/sites/bilibili/http.ts";
import { createBilibiliService } from "../../../../src/sites/bilibili/service.ts";
import { signedUrl } from "../../../../src/sites/bilibili/sign.ts";
import type { CaptionTrack, SiteCtx, SiteResult, SiteService, VideoInfo } from "../../../../src/sites/types.ts";
import { failure, testClock, value } from "../../../helpers/bilibili-fetch.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

const ACCOUNT_PATH = new URL(PROBE.account).pathname;
const SUBTITLE_PREFIX = "/bfs/subtitle/";
const REF: VideoRef = { platform: "bilibili", videoId: FIRST_VIDEO.bvid, segment: 1 };

const INFO: VideoInfo = {
  ref: REF,
  title: FIRST_VIDEO.title,
  author: FIRST_VIDEO.owner,
  channel: { platform: "bilibili", channelId: String(FIRST_VIDEO.mid) },
  description: "",
  durationSec: FIRST_VIDEO.duration,
  mediaVersion: String(FIRST_VIDEO.cid),
  siteRef: String(FIRST_VIDEO.aid),
};
const TRACK: CaptionTrack = { trackId: "zh-CN", lang: "zh-CN", label: "中文（中国）", kind: "human" };

interface Seen {
  readonly host: string;
  readonly path: string;
  readonly unexpected: boolean;
}

interface World {
  scenario: string;
  cookies: string;
  readonly clock: { at: number; now: () => number };
  readonly seen: Seen[];
  readonly service: Required<SiteService>;
  readonly ctx: SiteCtx;
}

/** 替身当浏览器用：只给带登录状态的 B 站请求带 Cookie，退避用真实实现，时钟由测试推。 */
function world(): World {
  const clock = testClock();
  const seen: Seen[] = [];
  const browserFetch = function (this: unknown, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    const { hostname: host, pathname: path, searchParams: query } = new URL(String(input));
    const cookie = init.credentials === "include" && host.endsWith(".bilibili.com") ? state.cookies : "";
    const answer = route({ host, path, query, cookie, now: clock.at }, state.scenario);
    seen.push({ host, path, unexpected: answer.unexpected === true });
    return Promise.resolve(new Response(answer.body ?? null, { status: answer.status, headers: answer.headers ?? {} }));
  } as typeof fetch;
  const backoff = createSiteBackoff({
    site: "bilibili",
    session: memoryStorage(),
    now: clock.now,
    sleep: async (ms) => {
      clock.at += ms;
    },
  });
  const state: World = {
    scenario: "",
    cookies: "",
    clock,
    seen,
    service: createBilibiliService({ now: clock.now }),
    ctx: { fetch: browserFetch.bind(globalThis), signal: new AbortController().signal, backoff },
  };
  return state;
}

/** 打开模拟登录页，把它设的 Cookie 记下。 */
function logIn(state: World): void {
  const { hostname: host, pathname: path, searchParams: query } = new URL(PROBE.login);
  const answer = route({ host, path, query, cookie: "" });
  const [cookie = ""] = (answer.headers?.["Set-Cookie"] ?? "").split(";");
  state.cookies = cookie;
}

function loggedInWorld(): World {
  const state = world();
  logIn(state);
  return state;
}

const contentRequests = (state: World): Seen[] => state.seen.filter((entry) => entry.path !== ACCOUNT_PATH);
const pathCount = (state: World, url: string): number => state.seen.filter((entry) => entry.path === new URL(url).pathname).length;
const captionFileCount = (state: World): number => state.seen.filter((entry) => entry.path.startsWith(SUBTITLE_PREFIX)).length;

function assertNoStray(state: World): void {
  assert.deepEqual(state.seen.filter((entry) => entry.unexpected), []);
}

type Read = (state: World) => Promise<SiteResult<unknown>>;

const READS: readonly (readonly [string, Read])[] = [
  ["视频信息", (state) => state.service.readVideoInfo(REF, state.ctx)],
  ["字幕轨", (state) => state.service.listCaptionTracks(INFO, state.ctx)],
  ["UP 主分段", (state) => state.service.readCreatorChapters(INFO, state.ctx)],
  ["官方总结", (state) => state.service.readOfficialSummary(INFO, state.ctx)],
  ["稍后再看", (state) => state.service.readWatchLater(state.ctx)],
];

test("走完登录、视频信息、字幕、分段、官方总结、稍后再看，意外请求为零", async () => {
  const state = loggedInWorld();
  const { service, ctx } = state;

  const info = value(await service.readVideoInfo(REF, ctx));
  assert.equal(info.title, FIRST_VIDEO.title);
  assert.equal(info.author, FIRST_VIDEO.owner);
  assert.equal(info.mediaVersion, String(FIRST_VIDEO.cid));
  assert.equal(info.siteRef, String(FIRST_VIDEO.aid));

  const tracks = value(await service.listCaptionTracks(info, ctx));
  assert.deepEqual(tracks.map((track) => [track.trackId, track.kind, track.isOriginalLang]), [
    ["zh-CN", "human", undefined],
    ["ai-en", "auto", undefined],
  ]);

  const [human] = tracks;
  assert.ok(human);
  const cues = value(await service.readCaptions(info, human, ctx));
  assert.deepEqual(cues.map((cue) => cue.text), ["样例台词一", "样例台词二"]);

  const chapters = value(await service.readCreatorChapters(info, ctx));
  assert.deepEqual(chapters.map((chapter) => chapter.title), ["样例分段一", "样例分段二"]);

  const summary = value(await service.readOfficialSummary(info, ctx));
  assert.equal(summary.status, "ok");
  assert.equal(summary.outline[0]?.title, "样例小节");
  assert.equal(summary.cues.length, 1);

  const list = value(await service.readWatchLater(ctx));
  assert.equal(list.total, 2);
  assert.deepEqual(list.items.map((item) => item.available), [true, true]);
  assert.ok(list.items[0]?.cover.endsWith(`${FIRST_VIDEO.bvid}.jpg`));

  assertNoStray(state);
  assert.equal(pathCount(state, PROBE.account), 1, "同一次读取操作只确认一次登录");
  assert.equal(pathCount(state, PLAYER_URL), 1, "字幕轨和分段共用一个列表请求");
});

test("列出来的每条字幕轨都读得到正文", async () => {
  const state = loggedInWorld();
  const info = value(await state.service.readVideoInfo(REF, state.ctx));
  for (const track of value(await state.service.listCaptionTracks(info, state.ctx))) {
    value(await state.service.readCaptions(info, track, state.ctx));
  }
  assert.equal(captionFileCount(state), 2);
  assertNoStray(state);
});

for (const [label, read] of [...READS, ["字幕正文", (state: World) => state.service.readCaptions(INFO, TRACK, state.ctx)] as const]) {
  test(`没登录时${label}报 NEED_LOGIN，内容请求一个都不发`, async () => {
    const state = world();
    assert.equal(failure(await read(state)).code, "NEED_LOGIN");
    assert.deepEqual(contentRequests(state), []);
    assertNoStray(state);
  });

  test(`logged-out：账号接口说没登录时${label}也不发内容请求`, async () => {
    const state = loggedInWorld();
    state.scenario = "logged-out";
    assert.equal(failure(await read(state)).code, "NEED_LOGIN");
    assert.deepEqual(contentRequests(state), []);
    assertNoStray(state);
  });
}

for (const scenario of ["http-429", "code-limited", "human-check"]) {
  for (const [label, read] of READS) {
    test(`${scenario}：${label}报 RATE_LIMITED，进退避，不重发，退避期内零请求`, async () => {
      const state = loggedInWorld();
      state.scenario = scenario;

      const first = failure(await read(state));
      assert.equal(first.code, "RATE_LIMITED");
      assert.ok((first.retryAfterSec ?? 0) >= 60);
      assert.equal(contentRequests(state).length, 1, "只发这一次");
      assert.equal(pathCount(state, PROBE.account), 1, "不重取密钥");

      // 再读一次是新的读取操作，登录确认也挡在退避外面。
      const sent = state.seen.length;
      const second = failure(await read({ ...state, ctx: { ...state.ctx } }));
      assert.equal(second.code, "RATE_LIMITED");
      assert.equal(state.seen.length, sent, "退避期内零请求");
      assertNoStray(state);
    });
  }
}

test("http-429：响应要求等更久时听它的", async () => {
  const state = loggedInWorld();
  state.scenario = "http-429";
  assert.equal(failure(await state.service.readVideoInfo(REF, state.ctx)).retryAfterSec, 120);
});

for (const [scenario, code] of [["api-403", "NETWORK"], ["html-200", "MALFORMED"]] as const) {
  test(`${scenario}：报 ${code} 并进退避，之后的请求不发`, async () => {
    const state = loggedInWorld();
    state.scenario = scenario;
    assert.equal(failure(await state.service.readVideoInfo(REF, state.ctx)).code, code);

    const sent = state.seen.length;
    assert.equal(failure(await state.service.readWatchLater(state.ctx)).code, "RATE_LIMITED");
    assert.equal(state.seen.length, sent);
    assertNoStray(state);
  });
}

test("sign-rejected-once：平台换过密钥时重取一次、重签一次就读到了，不进退避", async () => {
  const state = loggedInWorld();
  const info = value(await state.service.readVideoInfo(REF, state.ctx));
  state.clock.at += 2 * 60_000;
  state.scenario = "sign-rejected-once";

  const tracks = value(await state.service.listCaptionTracks(info, state.ctx));

  assert.equal(tracks.length, 2);
  assert.equal(pathCount(state, PLAYER_URL), 2, "被拒后重签一次");
  assert.equal(pathCount(state, PROBE.account), 2, "重取一次密钥");
  assert.equal(value(await state.service.readWatchLater(state.ctx)).total, 2, "没有进退避");
  assertNoStray(state);
});

const STOPPED_AT_INFO = [
  ["paid", "付费内容", "paid"],
  ["upower-only", "付费内容", "paid"],
  ["paid-unknown", "确认不了是否付费时", "paid-unknown"],
] as const;

for (const [scenario, label, detail] of STOPPED_AT_INFO) {
  test(`${scenario}：${label}报 UNPLAYABLE，字幕、分段、官方总结都不读`, async () => {
    const state = loggedInWorld();
    state.scenario = scenario;

    const result = failure(await state.service.readVideoInfo(REF, state.ctx));

    assert.equal(result.code, "UNPLAYABLE");
    assert.equal(result.detail, detail);
    assert.deepEqual(contentRequests(state).map((entry) => entry.path), [new URL(VIEW_URL).pathname]);
    assertNoStray(state);
  });
}

test("paid：稍后再看里的付费项标成不可用，别的项不受影响", async () => {
  const state = loggedInWorld();
  state.scenario = "paid";
  const { items } = value(await state.service.readWatchLater(state.ctx));
  assert.deepEqual(items.map((item) => [item.title, item.available, item.paidChecked]), [
    [FIRST_VIDEO.title, false, true],
    [SECOND_VIDEO.title, true, false],
  ]);
  assertNoStray(state);
});

test("upower-only：列表项没带充电标记时 paidChecked 为 false，要读视频信息才知道看不了", async () => {
  const state = loggedInWorld();
  state.scenario = "upower-only";
  const { items } = value(await state.service.readWatchLater(state.ctx));
  assert.deepEqual(items.map((item) => [item.title, item.available, item.paidChecked]), [
    [FIRST_VIDEO.title, true, false],
    [SECOND_VIDEO.title, true, false],
  ]);
  assert.equal(failure(await state.service.readVideoInfo(REF, state.ctx)).code, "UNPLAYABLE");
  assertNoStray(state);
});

test("not-found：报 NOT_FOUND，不进退避", async () => {
  const state = loggedInWorld();
  state.scenario = "not-found";
  assert.equal(failure(await state.service.readVideoInfo(REF, state.ctx)).code, "NOT_FOUND");
  assert.equal(value(await state.service.readWatchLater(state.ctx)).total, 2);
  assertNoStray(state);
});

test("不认识的视频号：报 NOT_FOUND", async () => {
  const state = loggedInWorld();
  const ref: VideoRef = { platform: "bilibili", videoId: "BV1Sample009", segment: 1 };
  assert.equal(failure(await state.service.readVideoInfo(ref, state.ctx)).code, "NOT_FOUND");
  assertNoStray(state);
});

test("模拟服务器回的视频信息就是请求的那个视频：两个样例视频都过得了身份核对", async () => {
  const state = loggedInWorld();
  for (const video of [FIRST_VIDEO, SECOND_VIDEO]) {
    const ref: VideoRef = { platform: "bilibili", videoId: video.bvid, segment: 1 };
    const info = value(await state.service.readVideoInfo(ref, state.ctx));
    assert.deepEqual(info.ref, ref);
    assert.equal(info.title, video.title);
    assert.equal(info.mediaVersion, String(video.cid));
  }
  assertNoStray(state);
});

test("no-captions：列表为空时返回空，只发这一次列表请求", async () => {
  const state = loggedInWorld();
  state.scenario = "no-captions";
  assert.deepEqual(value(await state.service.listCaptionTracks(INFO, state.ctx)), []);
  assert.equal(pathCount(state, PLAYER_URL), 1);
  assert.equal(captionFileCount(state), 0);
  assertNoStray(state);
});

test("empty-file：字幕文件没有正文时返回空，交给取字幕服务报错", async () => {
  const state = loggedInWorld();
  state.scenario = "empty-file";
  assert.deepEqual(value(await state.service.readCaptions(INFO, TRACK, state.ctx)), []);
  assertNoStray(state);
});

test("file-429：字幕文件被限流时停下，不试下一条，不重新列轨", async () => {
  const state = loggedInWorld();
  state.scenario = "file-429";
  assert.equal(failure(await state.service.readCaptions(INFO, TRACK, state.ctx)).code, "RATE_LIMITED");
  assert.equal(pathCount(state, PLAYER_URL), 1);
  assert.equal(captionFileCount(state), 1);

  const sent = state.seen.length;
  assert.equal(failure(await state.service.readCaptions(INFO, TRACK, state.ctx)).code, "RATE_LIMITED");
  assert.equal(state.seen.length, sent, "退避期内零请求");
  assertNoStray(state);
});

test("untrusted-file-host：不可信主机上的字幕地址一条都不收，报 MALFORMED，也不去下载", async () => {
  const state = loggedInWorld();
  state.scenario = "untrusted-file-host";
  const result = failure(await state.service.listCaptionTracks(INFO, state.ctx));
  assert.equal(result.code, "MALFORMED");
  assert.equal(result.detail, "no-usable-url");
  assert.equal(captionFileCount(state), 0);
  assertNoStray(state);
});

function ask(url: string, cookie: string, scenario = ""): ReturnType<typeof route> {
  const { hostname: host, pathname: path, searchParams: query } = new URL(url);
  return route({ host, path, query, cookie, now: testClock().at }, scenario);
}

test("模拟路由：不认识的主机和路径都标意外", () => {
  assert.equal(ask("https://sample.example.com/", "").unexpected, true);
  assert.equal(ask("https://www.bilibili.com/some/page", "").unexpected, true);
  assert.equal(ask("https://api.bilibili.com/x/some/other", PROBE.cookie).unexpected, true);
  assert.equal(ask("https://i0.hdslb.com/bfs/other/a.json", "").unexpected, true);
  assert.equal(ask("https://www.bilibili.com/favicon.ico", "").unexpected, undefined);
});

test("模拟路由：没带登录状态读内容标意外，账号接口不标", () => {
  for (const url of [VIEW_URL, PLAYER_URL, SUMMARY_URL, WATCH_LATER_URL]) {
    assert.equal(ask(url, "").unexpected, true, url);
  }
  const account = ask(PROBE.account, "");
  assert.equal(account.unexpected, undefined);
  assert.equal(JSON.parse(account.body ?? "").data.isLogin, false);
});

test("模拟路由：字幕文件带 Cookie 标意外", () => {
  assert.equal(ask(PROBE.file, PROBE.cookie).unexpected, true);
  assert.equal(ask(PROBE.file, "").status, 200);
});

test("模拟路由：签名不对或时间差太多都标意外，用当前密钥签的才放过", () => {
  const params = { bvid: FIRST_VIDEO.bvid, cid: FIRST_VIDEO.cid };
  const seconds = testClock().at / 1000;
  assert.equal(ask(signedUrl(SUMMARY_URL, params, KEYS, seconds), PROBE.cookie).unexpected, undefined);
  assert.equal(ask(signedUrl(SUMMARY_URL, params, ROTATED_KEYS, seconds), PROBE.cookie).unexpected, true);
  assert.equal(ask(signedUrl(SUMMARY_URL, params, KEYS, seconds - 3600), PROBE.cookie).unexpected, true);
});

test("主机映射只有三个站点主机和两家模拟的模型服务指向本机，其余域名解析失败", () => {
  const rules = hostRulesFor(4321).split(", ");
  assert.equal(rules.at(-1), "MAP * ~NOTFOUND");
  assert.equal(rules.length, 6);
  for (const rule of rules.slice(0, -1)) assert.match(rule, /^MAP \S+ 127\.0\.0\.1:4321$/);
  assert.equal(rules.filter((rule) => /openai|anthropic/i.test(rule)).length, 2);
  for (const rule of rules) assert.doesNotMatch(rule, /youtube/i);
});

test("慢场景只拖登录检查、视频信息、字幕列表和字幕文件，官方总结和别的主机照常", () => {
  const at = (url: string) => {
    const { hostname: host, pathname: path } = new URL(url);
    return slowed({ host, path });
  };
  for (const url of [PROBE.account, VIEW_URL, PLAYER_URL, PROBE.file]) assert.equal(at(url), true, url);
  assert.equal(at(WATCH_LATER_URL), false);
  assert.equal(at(signedUrl(SUMMARY_URL, { bvid: FIRST_VIDEO.bvid, cid: FIRST_VIDEO.cid }, KEYS, testClock().at / 1000)), false);
  assert.equal(at(PROBE.login), false);
});
