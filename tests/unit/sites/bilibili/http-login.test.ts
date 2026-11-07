// 登录门：每次读取操作确认一次登录。全部走严格替身，响应都是自造的，没配的地址直接抛错。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBiliHttp,
  NAV_URL,
  PLAYER_URL,
  VIEW_URL,
  WATCH_LATER_URL,
  type GetRequest,
} from "../../../../src/sites/bilibili/http.ts";
import type { SiteBackoff } from "../../../../src/sites/types.ts";
import { deferred, nextTurn, type Deferred } from "../../../helpers/deferred.ts";
import {
  failure,
  fakeBackoff,
  fakeSite,
  hanging,
  siteCtx,
  testClock,
  value,
  type FakeSite,
  type Route,
} from "../../../helpers/bilibili-fetch.ts";
import { BVID, json, navLoggedIn, navLoggedOut } from "../../../helpers/bilibili-fixtures.ts";

const VIEW: GetRequest = { url: VIEW_URL, params: { bvid: BVID } };
const FILE_URL = "https://aisubtitle.hdslb.com/bfs/subtitle/sample.json";
const SIGNED: GetRequest = { url: PLAYER_URL, params: { bvid: BVID, cid: 2002 }, signed: true };
const OK_DATA = { code: 0, data: { sample: true } };

const account: Route = () => json(200, navLoggedIn());
const okData: Route = () => json(200, OK_DATA);

// 账号接口停住，放行之后才回已登录。
const heldAccount = (gate: Deferred): Route => async () => {
  await gate.promise;
  return json(200, navLoggedIn());
};

async function waitForCalls(fake: FakeSite, endpoint: string, count: number): Promise<void> {
  while (fake.calls(endpoint).length < count) await nextTurn();
}

test("两次独立的读取操作各确认一次登录，隔得再近也不复用", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });
  const http = createBiliHttp();

  value(await http.getData(VIEW, siteCtx(fake)));
  value(await http.getData(VIEW, siteCtx(fake)));

  assert.deepEqual(
    fake.requests.map((request) => request.endpoint),
    [NAV_URL, VIEW_URL, NAV_URL, VIEW_URL],
    "每次都先确认再读",
  );
});

test("同一次读取操作连着读几样只确认一次登录，不看隔了多久", async () => {
  const time = testClock();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [PLAYER_URL]: okData, [WATCH_LATER_URL]: okData });
  const http = createBiliHttp({ now: time.now });
  const ctx = siteCtx(fake);

  value(await http.getData(VIEW, ctx));
  time.at += 10 * 60_000;
  value(await http.getData(SIGNED, ctx));
  value(await http.getData({ url: WATCH_LATER_URL }, ctx));
  value(await http.requireLogin(ctx));

  assert.equal(fake.calls(NAV_URL).length, 1);
});

test("两次读取操作同时确认登录只发一个账号请求，两边都记下结论", async () => {
  const gate = deferred();
  const fake = fakeSite({ [NAV_URL]: heldAccount(gate), [VIEW_URL]: okData });
  const http = createBiliHttp();
  const first = siteCtx(fake);
  const second = siteCtx(fake);

  const reads = [http.getData(VIEW, first), http.getData(VIEW, second)];
  await waitForCalls(fake, NAV_URL, 1);
  gate.resolve();
  for (const result of await Promise.all(reads)) value(result);
  assert.equal(fake.calls(NAV_URL).length, 1);

  value(await http.getData(VIEW, first));
  value(await http.getData(VIEW, second));
  assert.equal(fake.calls(NAV_URL).length, 1, "两次操作接着读都不再确认");
});

test("未登录不记，用户刚登录下一次就读得到", async () => {
  for (const reply of [navLoggedOut(), { code: 0, data: { isLogin: false } }]) {
    const fake = fakeSite({ [NAV_URL]: () => json(200, reply), [VIEW_URL]: okData });
    const http = createBiliHttp();
    const ctx = siteCtx(fake);

    assert.equal(failure(await http.getData(VIEW, ctx)).code, "NEED_LOGIN");
    assert.equal(fake.calls(VIEW_URL).length, 0);

    fake.routes.set(NAV_URL, account);
    value(await http.getData(VIEW, ctx));
    assert.equal(fake.calls(NAV_URL).length, 2, "这次重新问过账号接口");
  }
});

test("账号接口说没登录、缺字段都报 NEED_LOGIN，内容请求不发", async () => {
  const replies = [
    { code: 0, data: { isLogin: false } },
    { code: 0, data: {} },
    { code: 0 },
    { code: 0, data: { isLogin: "yes" } },
    { code: -101 },
    { data: { isLogin: true } },
    {},
    null,
  ];
  for (const reply of replies) {
    const fake = fakeSite({ [NAV_URL]: () => json(200, reply) });
    assert.equal(failure(await createBiliHttp().getData(VIEW, siteCtx(fake))).code, "NEED_LOGIN", JSON.stringify(reply));
    assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL]);
  }
});

test("账号接口超时、网络失败都不放行", async () => {
  const hung = fakeSite({ [NAV_URL]: hanging });
  assert.equal(failure(await createBiliHttp({ requestTimeoutMs: 20 }).getData(VIEW, siteCtx(hung))).code, "TIMEOUT");

  const broken = fakeSite({
    [NAV_URL]: () => {
      throw new TypeError("网络断了");
    },
  });
  assert.equal(failure(await createBiliHttp().getData(VIEW, siteCtx(broken))).code, "NETWORK");
  assert.deepEqual(broken.requests.map((request) => request.endpoint), [NAV_URL]);
});

test("确认不了不记：超时、网络失败、被限流之后，同一次操作下一次重新确认", async () => {
  const failures: readonly (readonly [string, Route])[] = [
    ["超时", hanging],
    [
      "网络失败",
      () => {
        throw new TypeError("网络断了");
      },
    ],
    ["被限流", () => json(200, { code: -412, message: "sample refusal" })],
  ];
  for (const [label, broken] of failures) {
    const backoff = fakeBackoff();
    const fake = fakeSite({ [NAV_URL]: broken, [VIEW_URL]: okData });
    const http = createBiliHttp({ requestTimeoutMs: 20 });
    const ctx = siteCtx(fake, backoff);

    failure(await http.getData(VIEW, ctx));
    backoff.blockedSec = 0;
    fake.routes.set(NAV_URL, account);
    value(await http.getData(VIEW, ctx));

    assert.equal(fake.calls(NAV_URL).length, 2, label);
    assert.equal(fake.calls(VIEW_URL).length, 1, label);
  }
});

test("在途的账号请求共用：一方取消只是不再等，另一方照常拿到结果", async () => {
  const gate = deferred();
  const fake = fakeSite({ [NAV_URL]: heldAccount(gate), [VIEW_URL]: okData });
  const http = createBiliHttp();
  const leaving = new AbortController();

  const cancelled = http.getData(VIEW, siteCtx(fake, undefined, leaving.signal));
  const staying = http.getData(VIEW, siteCtx(fake));
  await nextTurn();
  leaving.abort();

  assert.deepEqual(await cancelled, { ok: false, code: "NETWORK", detail: "aborted" });
  assert.equal(fake.calls(NAV_URL)[0]?.init.signal?.aborted, false, "共用的请求没被连累");
  gate.resolve();
  value(await staying);
  assert.equal(fake.calls(NAV_URL).length, 1);
  assert.equal(fake.calls(VIEW_URL).length, 1, "取消的那一方不再发内容请求");
});

test("已经取消的读取操作不发账号请求", async () => {
  const leaving = new AbortController();
  leaving.abort();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake, undefined, leaving.signal);

  assert.deepEqual(await http.requireLogin(ctx), { ok: false, code: "NETWORK", detail: "aborted" });
  assert.equal(failure(await http.getData(VIEW, ctx)).detail, "aborted");
  assert.deepEqual(fake.requests, []);
});

test("内容请求回未登录：所有操作记下的结论作废，同一次操作下一次也重新确认", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);
  const other = siteCtx(fake);
  value(await http.getData(VIEW, ctx));
  value(await http.getData(VIEW, other));

  fake.routes.set(VIEW_URL, () => json(200, { code: -101 }));
  assert.equal(failure(await http.getData(VIEW, ctx)).code, "NEED_LOGIN");
  fake.routes.set(VIEW_URL, okData);
  value(await http.getData(VIEW, ctx));
  value(await http.getData(VIEW, other));

  assert.equal(fake.calls(NAV_URL).length, 4);
});

test("forgetLogin 之后重新问账号接口", async () => {
  const fake = fakeSite({ [NAV_URL]: account });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);

  value(await http.requireLogin(ctx));
  http.forgetLogin();
  value(await http.requireLogin(ctx));
  assert.equal(fake.calls(NAV_URL).length, 2);
});

test("确认登录的途中收到未登录信号：这次不算确认，内容请求不发，下一次重新确认", async () => {
  const gate = deferred();
  const fake = fakeSite({ [NAV_URL]: heldAccount(gate), [VIEW_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake);

  const reading = http.getData(VIEW, ctx);
  await waitForCalls(fake, NAV_URL, 1);
  http.forgetLogin();
  gate.resolve();
  assert.equal(failure(await reading).code, "NEED_LOGIN");
  assert.equal(fake.calls(VIEW_URL).length, 0);

  fake.routes.set(NAV_URL, account);
  value(await http.getData(VIEW, ctx));
  assert.equal(fake.calls(NAV_URL).length, 2);
});

test("收到未登录信号以后才开始的操作不并进信号之前发出的账号请求", async () => {
  const gate = deferred();
  const fake = fakeSite({ [NAV_URL]: heldAccount(gate), [VIEW_URL]: okData });
  const http = createBiliHttp();

  const before = http.getData(VIEW, siteCtx(fake));
  await waitForCalls(fake, NAV_URL, 1);
  http.forgetLogin();
  const after = http.getData(VIEW, siteCtx(fake));
  await nextTurn();
  gate.resolve();

  assert.equal(failure(await before).code, "NEED_LOGIN");
  value(await after);
  assert.deepEqual(
    fake.requests.map((request) => request.endpoint),
    [NAV_URL, NAV_URL, VIEW_URL],
  );
});

test("排队等放行时收到未登录信号：放行后不发内容请求，报需要登录", async () => {
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData, [FILE_URL]: okData });
  const http = createBiliHttp();
  const gate = deferred();
  let admits = 0;
  const backoff: SiteBackoff = {
    admit: async () => {
      admits += 1;
      if (admits === 2) await gate.promise; // 账号请求放行，内容请求排着
      return { ok: true };
    },
    trip: async () => {},
    clear: async () => {},
  };
  const ctx = siteCtx(fake, backoff);

  const reading = http.getData(VIEW, ctx);
  while (admits < 2) await nextTurn();
  http.forgetLogin();
  gate.resolve();
  const result = failure(await reading);
  assert.equal(result.code, "NEED_LOGIN");
  assert.equal(fake.calls(VIEW_URL).length, 0);

  const next = siteCtx(fake, fakeBackoff());
  value(await http.requireLogin(next));
  http.forgetLogin();
  assert.equal(failure(await http.getFile(FILE_URL, next)).code, "NEED_LOGIN");
  assert.equal(fake.calls(FILE_URL).length, 0);
});

test("退避期内新的读取操作不发账号请求，直接报限流；退避过后照样先确认", async () => {
  const backoff = fakeBackoff();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });
  const http = createBiliHttp();
  value(await http.getData(VIEW, siteCtx(fake, backoff)));
  backoff.blockedSec = 30;
  const next = siteCtx(fake, backoff);

  const result = failure(await http.getData(VIEW, next));

  assert.equal(result.code, "RATE_LIMITED");
  assert.equal(result.retryAfterSec, 30);
  assert.equal(fake.calls(NAV_URL).length, 1, "账号请求也不发");
  assert.equal(fake.calls(VIEW_URL).length, 1);

  backoff.blockedSec = 0;
  value(await http.getData(VIEW, next));
  assert.equal(fake.calls(NAV_URL).length, 2, "挡下的那次没有记成已登录");
});

test("同一次操作里共用的请求不接调用方的取消信号，登录结论跟着带过去", async () => {
  const leaving = new AbortController();
  const fake = fakeSite({ [NAV_URL]: account, [VIEW_URL]: okData });
  const http = createBiliHttp();
  const ctx = siteCtx(fake, undefined, leaving.signal);
  value(await http.requireLogin(ctx));

  const shared = http.detach(ctx);
  leaving.abort();
  assert.equal(shared.signal.aborted, false);
  value(await http.getData(VIEW, shared));
  assert.equal(fake.calls(NAV_URL).length, 1, "沿用这次操作的结论");

  http.forgetLogin();
  value(await http.getData(VIEW, shared));
  assert.equal(fake.calls(NAV_URL).length, 2, "作废以后照样重新确认");

  value(await http.getData(VIEW, http.detach(siteCtx(fake))));
  assert.equal(fake.calls(NAV_URL).length, 3, "没确认过的操作带不过去");
});
