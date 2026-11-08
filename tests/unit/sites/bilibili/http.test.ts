// 请求出口：全部走严格替身，响应都是自造的，没配的地址直接抛错。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSiteBackoff } from "../../../../src/platform/site-backoff.ts";
import {
  createBiliHttp,
  NAV_URL,
  PLAYER_URL,
  SUMMARY_URL,
  VIEW_URL,
  WATCH_LATER_URL,
  type BiliHttp,
  type GetRequest,
} from "../../../../src/sites/bilibili/http.ts";
import type { SiteCtx, SiteFailure, SiteFailureReach, SiteResult } from "../../../../src/sites/types.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import {
  expectedSignature,
  failure,
  fakeBackoff,
  fakeSite,
  hanging,
  reachOf,
  signatureOf,
  siteCtx,
  testClock,
  value,
  type Route,
} from "../../../helpers/bilibili-fetch.ts";
import {
  BAN_RESPONSES,
  BVID,
  json,
  navLoggedIn,
  navLoggedOut,
  navWithoutKeys,
  SECOND_KEYS,
} from "../../../helpers/bilibili-fixtures.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

const FILE_URL = "https://aisubtitle.hdslb.com/bfs/subtitle/sample.json";
const VIEW: GetRequest = { url: VIEW_URL, params: { bvid: BVID } };
const SIGNED: GetRequest = { url: PLAYER_URL, params: { bvid: BVID, cid: 2002 }, signed: true };
const OK_DATA = { code: 0, data: { sample: true } };

const account: Route = () => json(200, navLoggedIn());
const okData: Route = () => json(200, OK_DATA);

// 响应头回来了，正文卡在半路。
const stalledBody: Route = () => new Response(new ReadableStream({ start() {} }));

const htmlPage = (): Response => new Response("<!DOCTYPE html><html>请先登录网络</html>", { status: 200 });

function rejectedOnce(reply: () => Response): Route {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? reply() : json(200, OK_DATA);
  };
}

const REFUSED = (): Response => json(200, { code: -352, message: "sample refusal" });

// 对照表的用例。

test("非零业务码映射成 SiteErrorCode，detail 留下原码", async () => {
  const cases = [
    [-101, "NEED_LOGIN"],
    [-404, "NOT_FOUND"],
    [62002, "NOT_FOUND"],
    [62004, "NOT_FOUND"],
    [-403, "UNPLAYABLE"],
    [-352, "RATE_LIMITED"],
    [-400, "MALFORMED"],
  ] as const;
  for (const [code, expected] of cases) {
    const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => json(200, { code, message: "sample" }) });
    const result = failure(await createBiliHttp().getData(VIEW, siteCtx(fake)));
    assert.equal(result.code, expected, `业务码 ${code}`);
    assert.equal(result.detail, `code:${code}`);
  }
});

test("HTTP 失败映射成 NETWORK", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => new Response("sample", { status: 500 }) });
  const result = failure(await createBiliHttp().getData(VIEW, siteCtx(fake)));
  assert.equal(result.code, "NETWORK");
  assert.equal(result.detail, "http:500");
});

test("字幕主链的请求一直不回时按时中止并报 TIMEOUT，不会一直挂着", async () => {
  const hung = fakeSite({ [NAV_URL]: account, [VIEW_URL]: hanging, [FILE_URL]: hanging });
  const http = createBiliHttp({ requestTimeoutMs: 20 });
  assert.equal(failure(await http.getData(VIEW, siteCtx(hung))).code, "TIMEOUT");
  assert.equal(hung.calls(VIEW_URL)[0]?.init.signal?.aborted, true, "底层请求真的被中止了");
  assert.equal(failure(await http.getFile(FILE_URL, siteCtx(hung))).code, "TIMEOUT");

  const stalled = fakeSite({ [NAV_URL]: account, [VIEW_URL]: stalledBody, [FILE_URL]: stalledBody });
  assert.equal(failure(await http.getData(VIEW, siteCtx(stalled))).code, "TIMEOUT");
  assert.equal(failure(await http.getFile(FILE_URL, siteCtx(stalled))).code, "TIMEOUT");
});

test("请求按时回来就不算超时，之后也不会再被中止", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });

  value(await createBiliHttp().getData({ ...VIEW, timeoutMs: 20 }, siteCtx(fake)));

  // 这里等的是时限过去，不是异步结果：过了时限计时器也不该再中止请求。
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(fake.calls(VIEW_URL)[0]?.init.signal?.aborted, false, "计时器已经清掉");
});

test("签名密钥（nav）返回的不是 JSON：报 MALFORMED，不带英文解析错误", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: htmlPage });

  const result = failure(await createBiliHttp().getData(SIGNED, siteCtx(fake, backoff)));

  assert.equal(result.code, "MALFORMED");
  assert.doesNotMatch(result.detail ?? "", /JSON|Unexpected/);
  assert.equal(backoff.trips.length, 1);
  assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL]);
});

for (const [label, ban] of BAN_RESPONSES) {
  test(`账号接口：${label} 时报 RATE_LIMITED，后面的请求不发`, async () => {
    const backoff = fakeBackoff();
    const fake = fakeSite({ [NAV_URL]: () => ban() });

    const result = failure(await createBiliHttp().getData(SIGNED, siteCtx(fake, backoff)));

    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(backoff.trips.length, 1);
    assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL], "不重发");
  });
}

test("HTTP 200 加 -352 仍归为 RATE_LIMITED", async () => {
  const refused = (): Response => json(200, { code: -352, message: "sample refusal" });
  for (const request of [VIEW, { url: WATCH_LATER_URL, timeoutMs: 15_000 }] as const) {
    const backoff = fakeBackoff();
    const fake = fakeSite({ [NAV_URL]: account, [request.url]: refused });

    const result = failure(await createBiliHttp().getData(request, siteCtx(fake, backoff)));

    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(backoff.trips.length, 1);
    assert.equal(fake.calls(request.url).length, 1);
  }
});

test("非 2xx 的响应体里有别的业务码时按业务码报，读不出响应体时仍是 NETWORK", async () => {
  const notFound = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => json(404, { code: -404, message: "sample" }) });
  assert.equal(failure(await createBiliHttp().getData(VIEW, siteCtx(notFound))).code, "NOT_FOUND");

  const gateway = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => new Response("sample", { status: 502 }) });
  assert.equal(failure(await createBiliHttp().getData(VIEW, siteCtx(gateway))).code, "NETWORK");

  const empty = fakeSite({ [NAV_URL]: account, [WATCH_LATER_URL]: () => new Response("", { status: 503 }) });
  const result = failure(await createBiliHttp().getData({ url: WATCH_LATER_URL }, siteCtx(empty)));
  assert.equal(result.code, "NETWORK");
  assert.equal(result.detail, "http:503");
});

test("账号接口回未登录：报 NEED_LOGIN，不取密钥也不发后续请求", async () => {
  const fake = fakeSite({ [NAV_URL]: () => json(200, navLoggedOut()) });
  const http = createBiliHttp();

  const result = failure(await http.getData(SIGNED, siteCtx(fake)));

  assert.equal(result.code, "NEED_LOGIN");
  assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL]);

  // 登录以后账号接口不再给密钥：未登录时那份没有留下，这次取不到密钥。
  fake.routes.set(NAV_URL, () => json(200, navWithoutKeys()));
  assert.equal(failure(await http.getData(SIGNED, siteCtx(fake))).detail, "no-signing-keys");
});

test("签名密钥一小时内复用，被拒后才重新拉取", async () => {
  const time = testClock();
  const fake = fakeSite({ [NAV_URL]: account, [PLAYER_URL]: okData });
  const http = createBiliHttp({ now: time.now });
  const ctx = siteCtx(fake);

  value(await http.getData(SIGNED, ctx));
  value(await http.getData(SIGNED, ctx));
  assert.equal(fake.calls(NAV_URL).length, 1, "第二次用缓存里的密钥");

  // 被拒了才换，换来的接着复用。
  time.at += 2 * 60_000;
  fake.routes.set(NAV_URL, () => json(200, navLoggedIn(SECOND_KEYS)));
  fake.routes.set(PLAYER_URL, rejectedOnce(REFUSED));
  value(await http.getData(SIGNED, ctx));
  value(await http.getData(SIGNED, ctx));
  assert.equal(fake.calls(NAV_URL).length, 2);

  // 新的读取操作要重新问账号接口；这次没带密钥，缓存里的还能用。
  fake.routes.set(NAV_URL, () => json(200, navWithoutKeys()));
  time.at += 59 * 60_000;
  value(await http.getData(SIGNED, siteCtx(fake)));
  assert.equal(fake.calls(NAV_URL).length, 3);
  const reused = fake.calls(PLAYER_URL).at(-1);
  assert.ok(reused);
  assert.equal(signatureOf(reused), expectedSignature(reused, SECOND_KEYS));

  time.at += 2 * 60_000;
  const players = fake.calls(PLAYER_URL).length;
  assert.equal(failure(await http.getData(SIGNED, siteCtx(fake))).detail, "no-signing-keys", "过了一小时不再用旧密钥");
  assert.equal(fake.calls(PLAYER_URL).length, players);
});

test("取签名密钥失败时不留半成品密钥", async () => {
  const fake = fakeSite({
    [NAV_URL]: () => new Response("sample", { status: 503 }),
    [PLAYER_URL]: okData,
  });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);
  assert.equal(failure(await http.getData(SIGNED, ctx)).code, "NETWORK");

  const halves: readonly unknown[] = [
    { code: 0, data: { isLogin: true, wbi_img: { img_url: "https://i0.hdslb.com/bfs/wbi/half.png" } } },
    { code: 0, data: { isLogin: true, wbi_img: { img_url: "https://i0.hdslb.com/a.png", sub_url: "https://i0.hdslb.com/b.png" } } },
  ];
  for (const half of halves) {
    fake.routes.set(NAV_URL, () => json(200, half));
    assert.equal(failure(await http.getData(SIGNED, ctx)).detail, "no-signing-keys");
  }
  assert.equal(fake.calls(PLAYER_URL).length, 0);

  fake.routes.set(NAV_URL, account);
  value(await http.getData(SIGNED, ctx));
  assert.equal(fake.calls(PLAYER_URL).length, 1);
});

test("并发取密钥只拉一次 nav：字幕列表和官方总结同时签名时共用", async () => {
  const gate = deferred();
  const fake = fakeSite({
    [NAV_URL]: async () => {
      await gate.promise;
      return json(200, navLoggedIn());
    },
    [PLAYER_URL]: okData,
    [SUMMARY_URL]: okData,
  });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);

  const reads = [http.getData(SIGNED, ctx), http.getData({ ...SIGNED, url: SUMMARY_URL }, ctx)];
  await nextTurn();
  gate.resolve();
  for (const result of await Promise.all(reads)) value(result);
  assert.equal(fake.calls(NAV_URL).length, 1);

  // 在途那次失败后不留坏状态，下一次照常重拉。
  const failing = createBiliHttp();
  fake.routes.set(NAV_URL, () => new Response("sample", { status: 503 }));
  assert.equal(failure(await failing.requireLogin(ctx)).code, "NETWORK");
  fake.routes.set(NAV_URL, account);
  value(await failing.requireLogin(ctx));
  assert.equal(fake.calls(NAV_URL).length, 3);
});

// 限速和退避。

test("退避期内一个请求都不发，账号接口也不发", async () => {
  const time = testClock();
  const backoff = createSiteBackoff({ site: "bilibili", session: memoryStorage(), now: time.now });
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [FILE_URL]: okData });
  const http = createBiliHttp({ now: time.now });
  const ctx = siteCtx(fake, backoff);
  await backoff.trip();

  const blocked = [
    await http.requireLogin(ctx),
    await http.getData(VIEW, ctx),
    await http.getData(SIGNED, ctx),
    await http.getFile(FILE_URL, ctx),
  ];

  for (const result of blocked) {
    assert.equal(failure(result).code, "RATE_LIMITED");
    assert.equal(failure(result).retryAfterSec, 60);
  }
  assert.deepEqual(fake.requests, []);

  time.at += 60_000;
  value(await http.getData(VIEW, ctx));
  assert.equal(fake.requests.length, 2, "到期放行下一次操作");
});

test("已登录的记录还在时，退避同样挡住内容请求", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake, backoff);
  value(await http.requireLogin(ctx));
  backoff.blockedSec = 30;

  const result = failure(await http.getData(VIEW, ctx));

  assert.equal(result.code, "RATE_LIMITED");
  assert.equal(result.retryAfterSec, 30);
  assert.equal(fake.calls(VIEW_URL).length, 0);
  assert.deepEqual(backoff.trips, [], "挡下的请求不算一次新的命中");
});

test("Retry-After 交给退避，结果里带上", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({
    [NAV_URL]: account,
    [VIEW_URL]: () => json(429, { code: -509 }, { "retry-after": "120" }),
  });

  const result = failure(await createBiliHttp().getData(VIEW, siteCtx(fake, backoff)));

  assert.equal(result.retryAfterSec, 120);
  assert.deepEqual(backoff.trips, [120]);
});

test("响应没说等多久时，结果里带退避要等的时间", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => json(200, { code: -412 }) });

  const result = failure(await createBiliHttp().getData(VIEW, siteCtx(fake, backoff)));

  assert.equal(result.retryAfterSec, 60);
  assert.deepEqual(backoff.trips, [undefined]);
});

test("退避记不下来也照样报限流", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => json(200, { code: -412 }) });
  const broken = { ...backoff, trip: () => Promise.reject(new Error("存储坏了")) };

  const result = failure(await createBiliHttp().getData(VIEW, siteCtx(fake, broken)));

  assert.equal(result.code, "RATE_LIMITED");
});

test("读取成功清连击，账号接口成功不算", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [FILE_URL]: () => json(200, { body: [] }) });
  const http = createBiliHttp();
  const ctx = siteCtx(fake, backoff);

  value(await http.requireLogin(ctx));
  assert.equal(backoff.clears, 0);

  value(await http.getData(VIEW, ctx));
  assert.equal(backoff.clears, 1);
  value(await http.getFile(FILE_URL, ctx));
  assert.equal(backoff.clears, 2);
});

test("每个请求都过限速，账号接口用不会被调用方中止的信号排队", async () => {
  const backoff = fakeBackoff();
  const leaving = new AbortController();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });

  value(await createBiliHttp().getData(VIEW, siteCtx(fake, backoff, leaving.signal)));

  assert.equal(backoff.admits.length, 2);
  assert.notEqual(backoff.admits[0], leaving.signal);
  assert.equal(backoff.admits[1], leaving.signal);
});

test("排队时取消：请求不发", async () => {
  const leaving = new AbortController();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [FILE_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake, undefined, leaving.signal);
  value(await http.requireLogin(ctx));
  leaving.abort();

  assert.equal(failure(await http.getData(VIEW, ctx)).code, "NETWORK");
  assert.equal(failure(await http.getFile(FILE_URL, ctx)).code, "NETWORK");
  assert.equal(fake.calls(VIEW_URL).length + fake.calls(FILE_URL).length, 0);
});

test("调用方取消时到点放手，替身不理会中止信号也一样", async () => {
  const leaving = new AbortController();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: () => new Promise(() => {}) });
  const http = createBiliHttp();

  const reading = http.getData(VIEW, siteCtx(fake, undefined, leaving.signal));
  await nextTurn();
  await nextTurn();
  leaving.abort();

  assert.equal(failure(await reading).code, "NETWORK");
});

// 影响范围：内容格式不对的失败都标上，批量处理据此跳过这一项或整批停下；别的错误码不标。

type Read = (http: BiliHttp, ctx: SiteCtx) => Promise<SiteResult<unknown>>;

interface ReachRow {
  readonly name: string;
  readonly routes: Readonly<Record<string, Route>>;
  readonly read: Read;
  readonly code: string;
  readonly reach?: SiteFailureReach;
}

const viaApi: Read = (http, ctx) => http.getData(VIEW, ctx);
const viaFile: Read = (http, ctx) => http.getFile(FILE_URL, ctx);
const apiReply = (reply: Route): Readonly<Record<string, Route>> => ({ [NAV_URL]: account, [VIEW_URL]: reply });

const REACH_ROWS: readonly ReachRow[] = [
  { name: "登录检查回了不认识的业务码", routes: { [NAV_URL]: () => json(200, { code: -400 }) }, read: viaApi, code: "MALFORMED", reach: "source" },
  { name: "登录检查回的不是 JSON", routes: { [NAV_URL]: htmlPage }, read: viaApi, code: "MALFORMED", reach: "source" },
  { name: "登录了但拿不到签名密钥", routes: { [NAV_URL]: () => json(200, navWithoutKeys()) }, read: (http, ctx) => http.getData(SIGNED, ctx), code: "MALFORMED", reach: "source" },
  { name: "接口回的不是 JSON", routes: apiReply(htmlPage), read: viaApi, code: "MALFORMED", reach: "source" },
  { name: "接口回的正文没有业务码", routes: apiReply(() => json(200, { data: {} })), read: viaApi, code: "MALFORMED", reach: "source" },
  { name: "接口回了不认识的业务码", routes: apiReply(() => json(200, { code: -400 })), read: viaApi, code: "MALFORMED", reach: "item" },
  { name: "字幕文件回的不是 JSON", routes: { [FILE_URL]: htmlPage }, read: viaFile, code: "MALFORMED", reach: "item" },
  { name: "字幕文件回了不认识的业务码", routes: { [FILE_URL]: () => json(200, { code: -400 }) }, read: viaFile, code: "MALFORMED", reach: "item" },
  { name: "字幕地址不在字幕文件的主机上", routes: {}, read: (http, ctx) => http.getFile("https://sample.example/zh.json", ctx), code: "MALFORMED", reach: "item" },
  { name: "被限流", routes: apiReply(() => json(200, { code: -412 })), read: viaApi, code: "RATE_LIMITED" },
  { name: "账号接口说没登录", routes: { [NAV_URL]: () => json(200, navLoggedOut()) }, read: viaApi, code: "NEED_LOGIN" },
  { name: "视频不存在", routes: apiReply(() => json(200, { code: -404 })), read: viaApi, code: "NOT_FOUND" },
  { name: "没有权限", routes: apiReply(() => json(200, { code: -403 })), read: viaApi, code: "UNPLAYABLE" },
  { name: "HTTP 失败", routes: apiReply(() => new Response("sample", { status: 500 })), read: viaApi, code: "NETWORK" },
];

for (const row of REACH_ROWS) {
  test(`影响范围：${row.name}，报 ${row.code}，${row.reach ? `标 ${row.reach}` : "不标影响范围"}`, async () => {
    const result = failure(await row.read(createBiliHttp(), siteCtx(fakeSite(row.routes))));

    assert.equal(result.code, row.code);
    assert.equal(reachOf(result), row.reach);
  });
}

test("类型上：内容格式不对必须标影响范围、不带等待时间，别的错误码不许标影响范围", () => {
  const malformed: SiteFailure = { ok: false, code: "MALFORMED", reach: "source" };
  const limited: SiteFailure = { ok: false, code: "RATE_LIMITED", retryAfterSec: 60 };
  // @ts-expect-error 内容格式不对时缺影响范围
  const unmarked: SiteFailure = { ok: false, code: "MALFORMED" };
  // @ts-expect-error 别的错误码不带影响范围
  const marked: SiteFailure = { ok: false, code: "NETWORK", reach: "item" };
  // @ts-expect-error 内容格式不对时没有等待时间
  const waiting: SiteFailure = { ok: false, code: "MALFORMED", reach: "item", retryAfterSec: 60 };

  // 不分错误码读等待时间照样能写。
  assert.deepEqual([malformed, limited].map((result) => result.retryAfterSec), [undefined, 60]);
  assert.deepEqual([unmarked, marked, waiting].map((result) => result.code), ["MALFORMED", "NETWORK", "MALFORMED"]);
});
