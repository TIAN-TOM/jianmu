// 请求出口的错误表逐行过，再看签名被拒之后怎么处理，以及请求本身的形状；响应都是自造的。
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import {
  createBiliHttp,
  isCaptionFileUrl,
  NAV_URL,
  PLAYER_URL,
  VIEW_URL,
  WATCH_LATER_URL,
  type GetRequest,
} from "../../../../src/sites/bilibili/http.ts";
import {
  expectedSignature,
  failure,
  fakeBackoff,
  fakeSite,
  hanging,
  signatureOf,
  siteCtx,
  testClock,
  value,
  type FakeSite,
  type Route,
} from "../../../helpers/bilibili-fetch.ts";
import { BVID, FIRST_KEYS, json, navLoggedIn, navLoggedOut, navWithoutKeys, SECOND_KEYS, viewEnvelope } from "../../../helpers/bilibili-fixtures.ts";
import { deferred, nextTurn, type Deferred } from "../../../helpers/deferred.ts";

const FILE_URL = "https://aisubtitle.hdslb.com/bfs/subtitle/sample.json";
const VIEW: GetRequest = { url: VIEW_URL, params: { bvid: BVID } };
const SIGNED: GetRequest = { url: PLAYER_URL, params: { bvid: BVID, cid: 2002 }, signed: true };
const OK_DATA = { code: 0, data: { sample: true } };

const account: Route = () => json(200, navLoggedIn());
const newKeys: Route = () => json(200, navLoggedIn(SECOND_KEYS));
const okData: Route = () => json(200, OK_DATA);
const htmlPage = (): Response => new Response("<!DOCTYPE html><html>请先登录网络</html>", { status: 200 });
const REFUSED = (): Response => json(200, { code: -352, message: "sample refusal" });

function rejectedOnce(reply: () => Response): Route {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? reply() : json(200, OK_DATA);
  };
}

// 响应头回来了，正文卡在半路。
const stalledBody = (status: number): Route => () =>
  new Response(new ReadableStream({ start() {} }), { status, headers: { "retry-after": "120" } });

// 账号接口停住，放行之后才回。
const heldAccount = (gate: Deferred, reply: unknown): Route => async () => {
  await gate.promise;
  return json(200, reply);
};

async function waitForCalls(fake: FakeSite, endpoint: string, count: number): Promise<void> {
  while (fake.calls(endpoint).length < count) await nextTurn();
}

// 就绪的微任务跑完还没结果，就是还在等。
function soon(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([work, nextTurn().then(() => "还在等")]);
}

interface TableRow {
  readonly name: string;
  readonly reply: () => Response;
  readonly code: string;
  readonly tripped: boolean;
  readonly detail?: string;
}

const API_ROWS: readonly TableRow[] = [
  { name: "接口 HTTP 403，读不出业务码", reply: () => new Response("sample", { status: 403 }), code: "NETWORK", tripped: true },
  { name: "接口 HTTP 403，读得出业务码", reply: () => json(403, { code: -403 }), code: "UNPLAYABLE", tripped: false },
  { name: "接口 HTTP 200，正文不是 JSON", reply: htmlPage, code: "MALFORMED", tripped: true },
  { name: "接口 HTTP 200，正文没有业务码", reply: () => json(200, { data: {} }), code: "MALFORMED", tripped: false, detail: "no-code" },
  { name: "接口 HTTP 200，正文是空值", reply: () => json(200, null), code: "MALFORMED", tripped: false, detail: "no-code" },
  { name: "接口 HTTP 500，读不出业务码", reply: () => new Response("", { status: 500 }), code: "NETWORK", tripped: false },
  { name: "接口 HTTP 412，正文业务码是 0", reply: () => json(412, { code: 0 }), code: "RATE_LIMITED", tripped: true },
  { name: "接口 HTTP 403，业务码表示限流", reply: () => json(403, { code: -799 }), code: "RATE_LIMITED", tripped: true },
];

for (const row of API_ROWS) {
  test(`错误表：${row.name}`, async () => {
    const backoff = fakeBackoff();
    const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: row.reply });

    const result = failure(await createBiliHttp().getData(VIEW, siteCtx(fake, backoff)));

    assert.equal(result.code, row.code);
    if (row.detail) assert.equal(result.detail, row.detail);
    assert.equal(backoff.trips.length, row.tripped ? 1 : 0);
    assert.equal(fake.calls(VIEW_URL).length, 1, "不重发");
  });
}

const FILE_ROWS: readonly TableRow[] = [
  { name: "字幕文件 HTTP 403", reply: () => new Response("sample", { status: 403 }), code: "NETWORK", tripped: false },
  { name: "字幕文件 HTTP 404", reply: () => new Response("sample", { status: 404 }), code: "NETWORK", tripped: false },
  { name: "字幕文件 HTTP 200，正文不是 JSON", reply: htmlPage, code: "MALFORMED", tripped: false },
  { name: "字幕文件 HTTP 429", reply: () => new Response("sample", { status: 429 }), code: "RATE_LIMITED", tripped: true },
  { name: "字幕文件 HTTP 412", reply: () => new Response("sample", { status: 412 }), code: "RATE_LIMITED", tripped: true },
  { name: "字幕文件正文里的限流业务码", reply: () => json(200, { code: -412 }), code: "RATE_LIMITED", tripped: true },
  { name: "字幕文件正文里别的业务码", reply: () => json(200, { code: -400 }), code: "MALFORMED", tripped: false, detail: "code:-400" },
];

for (const row of FILE_ROWS) {
  test(`错误表：${row.name}`, async () => {
    const backoff = fakeBackoff();
    const fake = fakeSite({ [FILE_URL]: row.reply });

    const result = failure(await createBiliHttp().getFile(FILE_URL, siteCtx(fake, backoff)));

    assert.equal(result.code, row.code);
    if (row.detail) assert.equal(result.detail, row.detail);
    assert.equal(backoff.trips.length, row.tripped ? 1 : 0);
    assert.equal(fake.calls(FILE_URL).length, 1, "不重发");
  });
}

test("错误表：请求抛错报 NETWORK，到时限报 TIMEOUT，都不进退避", async () => {
  const backoff = fakeBackoff();
  const broken = fakeSite({
    [NAV_URL]: account,
    [VIEW_URL]: () => {
      throw new TypeError("网络断了");
    },
  });
  assert.equal(failure(await createBiliHttp().getData(VIEW, siteCtx(broken, backoff))).code, "NETWORK");

  const hung = fakeSite({ [NAV_URL]: account, [VIEW_URL]: hanging });
  assert.equal(failure(await createBiliHttp().getData({ ...VIEW, timeoutMs: 20 }, siteCtx(hung, backoff))).code, "TIMEOUT");
  assert.deepEqual(backoff.trips, []);
});

test("字幕文件读到一半断开报 NETWORK", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"body":'));
      controller.error(new TypeError("网络断了"));
    },
  });
  const fake = fakeSite({ [FILE_URL]: () => new Response(body) });

  assert.equal(failure(await createBiliHttp().getFile(FILE_URL, siteCtx(fake))).code, "NETWORK");
});

for (const status of [412, 429]) {
  test(`HTTP ${status} 一到就按限流进退避，不等卡住的正文，等多久照听响应头`, async () => {
    const backoff = fakeBackoff();
    let cancelled = false;
    const body = new ReadableStream({ cancel: () => void (cancelled = true) });
    const limited: Route = () => new Response(body, { status, headers: { "Retry-After": "120" } });
    const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: limited });

    const result = failure(await createBiliHttp().getData({ ...VIEW, timeoutMs: 2_000 }, siteCtx(fake, backoff)));
    assert.ok(cancelled, "没等正文，直接取消");

    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(result.detail, `http:${status}`);
    assert.equal(result.retryAfterSec, 120);
    assert.deepEqual(backoff.trips, [120]);
    assert.equal(fake.calls(VIEW_URL).length, 1, "不重发");
  });

  test(`HTTP ${status} 的正文没读完就取消：同样按限流进退避`, async () => {
    const backoff = fakeBackoff();
    const leaving = new AbortController();
    const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: stalledBody(status) });

    const reading = createBiliHttp().getData(VIEW, siteCtx(fake, backoff, leaving.signal));
    await waitForCalls(fake, VIEW_URL, 1);
    leaving.abort();
    const result = failure(await reading);

    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(result.detail, `http:${status}`);
    assert.deepEqual(backoff.trips, [120]);
  });
}

// 签名接口被拒之后最多换一次密钥。

// 取到密钥以后过了多久才发这次请求。
async function signedAfter(ageMs: number, nav: Route, player: Route) {
  const time = testClock();
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [PLAYER_URL]: player });
  const http = createBiliHttp({ now: time.now });
  const ctx = siteCtx(fake, backoff);
  value(await http.getData(VIEW, ctx));
  fake.routes.set(NAV_URL, nav);
  time.at += ageMs;
  return { result: await http.getData(SIGNED, ctx), fake, backoff };
}

test("签名被拒、密钥取到超过 60 秒：重取一次，密钥变了就重签一次", async () => {
  const { result, fake, backoff } = await signedAfter(
    61_000,
    () => json(200, navLoggedIn(SECOND_KEYS)),
    rejectedOnce(REFUSED),
  );

  assert.deepEqual(value(result), OK_DATA.data);
  const [first, second] = fake.calls(PLAYER_URL);
  assert.ok(first && second);
  assert.equal(signatureOf(first), expectedSignature(first, FIRST_KEYS));
  assert.equal(signatureOf(second), expectedSignature(second, SECOND_KEYS));
  assert.deepEqual(backoff.trips, []);
});

test("重签之后又被拒：进退避，不再重发", async () => {
  const { result, fake, backoff } = await signedAfter(61_000, () => json(200, navLoggedIn(SECOND_KEYS)), REFUSED);

  assert.equal(failure(result).code, "RATE_LIMITED");
  assert.equal(fake.calls(PLAYER_URL).length, 2);
  assert.equal(backoff.trips.length, 1);
});

test("重取到的密钥没变：进退避，不重发", async () => {
  const { result, fake, backoff } = await signedAfter(61_000, account, rejectedOnce(REFUSED));

  assert.equal(failure(result).code, "RATE_LIMITED");
  assert.equal(fake.calls(PLAYER_URL).length, 1);
  assert.equal(fake.calls(NAV_URL).length, 2);
  assert.equal(backoff.trips.length, 1);
});

test("密钥刚取到就被拒：不重取，进退避", async () => {
  const { result, fake, backoff } = await signedAfter(59_000, account, rejectedOnce(REFUSED));

  assert.equal(failure(result).code, "RATE_LIMITED");
  assert.equal(fake.calls(PLAYER_URL).length, 1);
  assert.equal(fake.calls(NAV_URL).length, 1);
  assert.equal(backoff.trips.length, 1);
});

test("被拒的响应带着内容：按人机验证停下，不重取不重发", async () => {
  const humanCheck = (): Response => json(200, { code: -352, data: { challenge: "sample" } });
  const { result, fake, backoff } = await signedAfter(61_000, account, rejectedOnce(humanCheck));

  assert.equal(failure(result).code, "RATE_LIMITED");
  assert.equal(fake.calls(PLAYER_URL).length, 1);
  assert.equal(fake.calls(NAV_URL).length, 1);
  assert.equal(backoff.trips.length, 1);
});

test("被拒的响应带着空内容：仍算普通被拒，重签一次成功", async () => {
  const emptyData = (): Response => json(200, { code: -352, data: {} });
  const { result, fake, backoff } = await signedAfter(61_000, newKeys, rejectedOnce(emptyData));

  assert.deepEqual(value(result), OK_DATA.data);
  assert.equal(fake.calls(PLAYER_URL).length, 2);
  assert.deepEqual(backoff.trips, []);
});

for (const status of [412, 429]) {
  test(`状态码已经表明限流时不换密钥：HTTP ${status}`, async () => {
    const banned = (): Response => json(status, { code: -352 });
    const { result, fake, backoff } = await signedAfter(61_000, newKeys, rejectedOnce(banned));

    assert.equal(failure(result).code, "RATE_LIMITED");
    assert.equal(fake.calls(PLAYER_URL).length, 1);
    assert.equal(fake.calls(NAV_URL).length, 1);
    assert.equal(backoff.trips.length, 1);
  });
}

test("重取密钥失败：照报限流，不重发", async () => {
  const { result, fake, backoff } = await signedAfter(
    61_000,
    () => new Response("sample", { status: 503 }),
    rejectedOnce(REFUSED),
  );

  assert.equal(failure(result).code, "RATE_LIMITED");
  assert.equal(fake.calls(PLAYER_URL).length, 1);
  assert.equal(backoff.trips.length, 1);
});

test("重取密钥时账号接口说未登录：报 NEED_LOGIN，不进退避，不重发", async () => {
  for (const reply of [navLoggedOut(), { code: 0, data: { isLogin: false } }]) {
    const { result, fake, backoff } = await signedAfter(61_000, () => json(200, reply), rejectedOnce(REFUSED));

    assert.equal(failure(result).code, "NEED_LOGIN");
    assert.equal(fake.calls(PLAYER_URL).length, 1);
    assert.deepEqual(backoff.trips, []);
  }
});

test("重取密钥时调用方取消：立刻报取消，不进退避，不重发", async () => {
  const time = testClock();
  const backoff = fakeBackoff();
  const gate = deferred();
  const fake = fakeSite({ [NAV_URL]: account, [PLAYER_URL]: REFUSED });
  const http = createBiliHttp({ now: time.now });
  const leaving = new AbortController();
  const ctx = siteCtx(fake, backoff, leaving.signal);
  value(await http.requireLogin(ctx));
  fake.routes.set(NAV_URL, heldAccount(gate, navLoggedIn(SECOND_KEYS)));
  time.at += 61_000;

  const reading = http.getData(SIGNED, ctx);
  await waitForCalls(fake, NAV_URL, 2);
  leaving.abort();
  const result = await soon(reading);
  gate.resolve();

  assert.deepEqual(result, { ok: false, code: "NETWORK", detail: "aborted" });
  assert.equal(fake.calls(PLAYER_URL).length, 1);
  assert.deepEqual(backoff.trips, []);
});

test("已登录记录还在、取密钥时账号接口说未登录：报 NEED_LOGIN，记录清掉，内容请求不发", async () => {
  const fake = fakeSite({ [NAV_URL]: () => json(200, navWithoutKeys()), [PLAYER_URL]: okData, [VIEW_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);
  value(await http.requireLogin(ctx));
  fake.routes.set(NAV_URL, () => json(200, { code: 0, data: { isLogin: false } }));

  assert.equal(failure(await http.getData(SIGNED, ctx)).code, "NEED_LOGIN");
  assert.equal(failure(await http.getData(VIEW, ctx)).code, "NEED_LOGIN");

  assert.equal(fake.calls(PLAYER_URL).length, 0);
  assert.equal(fake.calls(VIEW_URL).length, 0);
});

test("已登录记录还在、取密钥时调用方取消：立刻报取消", async () => {
  const gate = deferred();
  const fake = fakeSite({ [NAV_URL]: () => json(200, navWithoutKeys()) });
  const http = createBiliHttp();
  const leaving = new AbortController();
  const ctx = siteCtx(fake, undefined, leaving.signal);
  value(await http.requireLogin(ctx));
  fake.routes.set(NAV_URL, heldAccount(gate, navLoggedIn()));

  const reading = http.getData(SIGNED, ctx);
  await waitForCalls(fake, NAV_URL, 2);
  leaving.abort();
  const result = await soon(reading);
  gate.resolve();

  assert.deepEqual(result, { ok: false, code: "NETWORK", detail: "aborted" });
});

test("重签之前别的请求已经换过密钥：直接用新的，不多问账号接口", async () => {
  const gate = deferred();
  const fake = fakeSite({
    [NAV_URL]: account,
    [VIEW_URL]: okData,
    [PLAYER_URL]: async () => {
      await gate.promise;
      return REFUSED();
    },
  });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);
  value(await http.requireLogin(ctx));

  const reading = http.getData(SIGNED, ctx);
  await nextTurn();
  await nextTurn();
  // 被拒之前另一次读取操作确认登录，顺带把密钥换了。
  fake.routes.set(NAV_URL, () => json(200, navLoggedIn(SECOND_KEYS)));
  value(await http.getData(VIEW, siteCtx(fake)));
  fake.routes.set(PLAYER_URL, okData);
  gate.resolve();

  value(await reading);
  assert.equal(fake.calls(NAV_URL).length, 2);
  const second = fake.calls(PLAYER_URL)[1];
  assert.ok(second);
  assert.equal(signatureOf(second), expectedSignature(second, SECOND_KEYS));
});

test("签名用放行之后的时间，排队的时间不算进去", async () => {
  const time = testClock();
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [PLAYER_URL]: okData });
  const http = createBiliHttp({ now: time.now });
  const queued = {
    ...backoff,
    admit: async (signal: AbortSignal) => {
      time.at += 30_000;
      return backoff.admit(signal);
    },
  };

  value(await http.getData(SIGNED, siteCtx(fake, queued)));

  const seen = fake.calls(PLAYER_URL)[0];
  assert.ok(seen);
  assert.equal(Number(seen.query.get("wts")), Math.floor(time.at / 1000));
});

test("不签名的接口查询串里没有签名", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [WATCH_LATER_URL]: okData });
  const http = createBiliHttp();

  value(await http.getData(VIEW, siteCtx(fake)));
  value(await http.getData({ url: WATCH_LATER_URL }, siteCtx(fake)));

  assert.equal(fake.calls(VIEW_URL)[0]?.url, `${VIEW_URL}?bvid=${BVID}`);
  assert.equal(fake.calls(WATCH_LATER_URL)[0]?.url, WATCH_LATER_URL);
});

// 请求本身。

test("没写时限的请求按 12 秒算：差一毫秒不中止，到点报 TIMEOUT", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: hanging });

  const reading = createBiliHttp().getData(VIEW, siteCtx(fake));
  await waitForCalls(fake, VIEW_URL, 1);

  t.mock.timers.tick(11_999);
  assert.equal(fake.calls(VIEW_URL)[0]?.init.signal?.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(fake.calls(VIEW_URL)[0]?.init.signal?.aborted, true);
  assert.equal(failure(await reading).code, "TIMEOUT");
});

test("请求结束后不留中止监听", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });

  value(await createBiliHttp().getData(VIEW, siteCtx(fake)));

  assert.equal(fake.requests.length, 2);
  for (const request of fake.requests) {
    assert.ok(request.init.signal);
    assert.equal(getEventListeners(request.init.signal, "abort").length, 0, request.endpoint);
  }
});

test("请求头只有 Accept，接口带登录状态，字幕文件不带", async () => {
  const fake = fakeSite({
    [NAV_URL]: account,
    [VIEW_URL]: () => json(200, viewEnvelope()),
    [PLAYER_URL]: okData,
    [FILE_URL]: () => json(200, { body: [] }),
  });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);

  value(await http.getData(VIEW, ctx));
  value(await http.getData(SIGNED, ctx));
  value(await http.getFile(FILE_URL, ctx));

  for (const request of fake.requests) {
    assert.deepEqual(request.headers, { accept: "application/json" }, request.endpoint);
  }
  for (const request of fake.requests.slice(0, 3)) {
    assert.equal(request.init.credentials, "include");
    assert.equal(request.init.cache, "no-store");
  }
  const file = fake.calls(FILE_URL)[0];
  assert.equal(file?.init.credentials, "omit");
  assert.equal(file?.init.cache, "default");
});

test("字幕文件的地址在发请求之前核对：只收 https 和字幕文件的主机", async () => {
  const fake = fakeSite();
  const http = createBiliHttp();
  const refused = [
    "http://aisubtitle.hdslb.com/bfs/subtitle/sample.json",
    "https://sample.example/bfs/subtitle/sample.json",
    "https://hdslb.com.sample.example/sample.json",
    "https://aisubtitle.hdslb.com@sample.example/sample.json",
    "https://samplehdslb.com/sample.json",
    "不是地址",
  ];
  for (const url of refused) {
    assert.equal(isCaptionFileUrl(url), false, url);
    assert.deepEqual(await http.getFile(url, siteCtx(fake)), { ok: false, code: "MALFORMED", reach: "item", detail: "untrusted-file-host" });
  }
  assert.deepEqual(fake.requests, []);
  assert.equal(isCaptionFileUrl(FILE_URL), true);
});

test("字幕文件的结果是整份正文，接口的结果是信封里的数据", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [FILE_URL]: () => json(200, { body: [{ from: 0 }] }) });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);

  assert.deepEqual(value(await http.getData(VIEW, ctx)), { sample: true });
  assert.deepEqual(value(await http.getFile(FILE_URL, ctx)), { body: [{ from: 0 }] });
});

test("替身遇到没配的地址抛错并记下这次请求，出口报 NETWORK", async () => {
  const fake = fakeSite({ [NAV_URL]: account });
  assert.equal(failure(await createBiliHttp().getData(VIEW, siteCtx(fake))).code, "NETWORK");
  assert.equal(fake.calls(VIEW_URL).length, 1);
});
