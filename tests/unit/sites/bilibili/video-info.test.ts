// 视频信息和付费判断：请求走严格替身，响应都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import { createBiliHttp, NAV_URL, VIEW_URL } from "../../../../src/sites/bilibili/http.ts";
import { paidStatus, parseVideoInfo, readVideoInfo } from "../../../../src/sites/bilibili/video-info.ts";
import type { VideoInfo } from "../../../../src/sites/types.ts";
import { failure, fakeBackoff, fakeSite, siteCtx, value, type Route } from "../../../helpers/bilibili-fetch.ts";
import { BAN_RESPONSES, BVID, json, navLoggedIn, viewData, viewEnvelope } from "../../../helpers/bilibili-fixtures.ts";

const REF: VideoRef = { platform: "bilibili", videoId: BVID, segment: 1 };

function site(view: Route) {
  return fakeSite({ [NAV_URL]: () => json(200, navLoggedIn()), [VIEW_URL]: view });
}

const TWO_PARTS = viewData({
  title: "合集总标题",
  cid: 111,
  duration: 900,
  pages: [
    { page: 1, cid: 111, part: "第一集", duration: 300 },
    { page: 2, cid: 222, part: "第二集", duration: 600 },
  ],
});

test("分 P 视频取对应分 P 的 cid、时长与标题", () => {
  const first = value(parseVideoInfo(TWO_PARTS, { ...REF, segment: 1 }));
  assert.equal(first.mediaVersion, "111");
  assert.equal(first.title, "第一集");
  assert.equal(first.durationSec, 300);
  assert.equal(first.author, "样例作者");
  assert.equal(first.segments?.length, 2);

  const second = value(parseVideoInfo(TWO_PARTS, { ...REF, segment: 2 }));
  assert.equal(second.mediaVersion, "222");
  assert.equal(second.title, "第二集");
  assert.equal(second.durationSec, 600);
});

test("单 P 视频用视频标题而非分 P 标题", () => {
  const data = viewData({ title: "视频标题", pages: [{ page: 1, cid: 999, part: "分 P 标题", duration: 120 }] });
  const info = value(parseVideoInfo(data, REF));
  assert.equal(info.title, "视频标题");
  assert.equal(info.segments?.length, 1);
});

test("视频信息带上登录状态并请求正确的地址", async () => {
  const fake = site(() => json(200, viewEnvelope()));

  const info = value(await readVideoInfo(createBiliHttp(), REF, siteCtx(fake)));

  const [seen] = fake.calls(VIEW_URL);
  assert.ok(seen);
  assert.equal(seen.url, `${VIEW_URL}?bvid=${BVID}`);
  assert.equal(seen.init.credentials, "include");
  assert.equal(seen.init.cache, "no-store");
  assert.equal(info.mediaVersion, "2002");
});

test("视频信息返回的不是 JSON：报 MALFORMED", async () => {
  const pages = ["<!DOCTYPE html><html>请先登录网络</html>", '{"code":0,"data":{"aid":1'];
  for (const page of pages) {
    const backoff = fakeBackoff();
    const result = failure(await readVideoInfo(createBiliHttp(), REF, siteCtx(site(() => new Response(page)), backoff)));
    assert.equal(result.code, "MALFORMED");
    assert.doesNotMatch(result.detail ?? "", /JSON|Unexpected/);
    assert.equal(backoff.trips.length, 1, "批次靠退避停下");
  }
});

for (const [label, ban] of BAN_RESPONSES) {
  test(`视频信息：${label} 归为 RATE_LIMITED`, async () => {
    const backoff = fakeBackoff();
    const fake = site(() => ban());

    const result = failure(await readVideoInfo(createBiliHttp(), REF, siteCtx(fake, backoff)));

    assert.equal(result.code, "RATE_LIMITED");
    assert.equal(backoff.trips.length, 1);
    assert.equal(fake.calls(VIEW_URL).length, 1, "不重发");
  });
}

test("把 UP 主、aid、cid 放进内部结构，不填音频语言", () => {
  const info: VideoInfo = value(parseVideoInfo(viewData(), REF));
  assert.deepEqual(info, {
    ref: REF,
    title: "样例视频",
    author: "样例作者",
    channel: { platform: "bilibili", channelId: "3003" },
    description: "样例简介",
    durationSec: 120,
    mediaVersion: "2002",
    siteRef: "1001",
    segments: [{ index: 1, title: "样例视频", durationSec: 120 }],
  });
});

test("分 P 超范围报 SEGMENT_OUT_OF_RANGE，不退回第 1 P", () => {
  assert.deepEqual(parseVideoInfo(TWO_PARTS, { ...REF, segment: 3 }), { ok: false, code: "SEGMENT_OUT_OF_RANGE" });
  assert.deepEqual(parseVideoInfo(viewData({ pages: [] }), { ...REF, segment: 2 }), {
    ok: false,
    code: "SEGMENT_OUT_OF_RANGE",
  });
});

test("没有分 P 列表时第 1 P 用视频本身的 cid 和时长", () => {
  const info = value(parseVideoInfo(viewData({ pages: [] }), REF));
  assert.equal(info.mediaVersion, "2002");
  assert.equal(info.durationSec, 120);
  assert.deepEqual(info.segments, []);
});

test("选中的那一 P 缺 cid 时报 MALFORMED，不退回视频本身的 cid", () => {
  const data = viewData({ cid: 111, pages: [{ page: 1, cid: 111 }, { page: 2 }] });
  assert.deepEqual(parseVideoInfo(data, { ...REF, segment: 2 }), { ok: false, code: "MALFORMED", reach: "item", detail: "no-cid" });
});

test("缺 cid 报 MALFORMED", () => {
  const result = parseVideoInfo(viewData({ cid: 0, pages: [{ page: 1, part: "样例" }] }), REF);
  assert.deepEqual(result, { ok: false, code: "MALFORMED", reach: "item", detail: "no-cid" });
});

const OTHER_BVID = "BV1Sample999";
const MISMATCH = { ok: false, code: "MALFORMED", reach: "source", detail: "video-mismatch" };
const OTHER_VIDEO = { bvid: OTHER_BVID, aid: 9009, cid: 8008, title: "另一个样例视频", pages: [{ page: 1, cid: 8008, part: "另一个样例视频", duration: 300 }] };

test("请求 A、返回 B：报 MALFORMED，影响整条读取路线，B 的标题和 cid 都不用", async () => {
  assert.deepEqual(parseVideoInfo(viewData(OTHER_VIDEO), REF), MISMATCH);

  const fake = site(() => json(200, viewEnvelope(OTHER_VIDEO)));
  const result = await readVideoInfo(createBiliHttp(), REF, siteCtx(fake));

  assert.deepEqual(result, MISMATCH);
  assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL, VIEW_URL], "对不上就停，后面的请求不发");
});

test("返回的视频信息缺 bvid 或写法不同：一样当作对不上", () => {
  for (const bvid of [undefined, null, "", 1001, BVID.toLowerCase(), ` ${BVID}`, [BVID]]) {
    assert.deepEqual(parseVideoInfo(viewData({ bvid }), REF), MISMATCH, JSON.stringify(bvid));
  }
  const { bvid: _bvid, ...withoutId } = viewData();
  assert.deepEqual(parseVideoInfo(withoutId, REF), MISMATCH, "整个缺这一项");
});

test("请求 A、返回的 B 是付费视频：报对不上，不把 B 的付费结论记到 A 上", () => {
  for (const marks of [{ rights: { pay: 1 } }, { is_upower_exclusive: true }, { rights: { pay: 0, ugc_pay: 0 } }]) {
    assert.deepEqual(parseVideoInfo(viewData({ ...OTHER_VIDEO, ...marks }), REF), MISMATCH, JSON.stringify(marks));
  }
});

test("返回的视频和请求的一致：照常读出，身份就是请求的那个", async () => {
  const fake = site(() => json(200, viewEnvelope(TWO_PARTS)));
  const second = value(await readVideoInfo(createBiliHttp(), { ...REF, segment: 2 }, siteCtx(fake)));
  assert.deepEqual(second.ref, { ...REF, segment: 2 });
  assert.equal(second.mediaVersion, "222");
  assert.deepEqual(value(parseVideoInfo(viewData(), REF)).ref, REF);
});

const FREE_RIGHTS = { pay: 0, ugc_pay: 0, arc_pay: 0 };
const PAID = { ok: false, code: "UNPLAYABLE", detail: "paid" };
const PAID_UNKNOWN = { ok: false, code: "UNPLAYABLE", detail: "paid-unknown" };

const PAID_MARKS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["rights.pay 为真", { rights: { ...FREE_RIGHTS, pay: 1 } }],
  ["rights.ugc_pay 为真", { rights: { ...FREE_RIGHTS, ugc_pay: 1 } }],
  ["rights.arc_pay 为真", { rights: { ...FREE_RIGHTS, arc_pay: true } }],
  ["is_upower_exclusive 为真", { is_upower_exclusive: true }],
  ["只有 rights.pay 且为真", { rights: { pay: 1 } }],
  ["rights.pay 为真、别的写法不对", { rights: { pay: 2, ugc_pay: "0", arc_pay: null }, is_upower_exclusive: "false" }],
];

for (const [label, marks] of PAID_MARKS) {
  test(`${label}：报 UNPLAYABLE，后面的请求都不发`, async () => {
    const fake = site(() => json(200, viewEnvelope(marks)));

    const result = await readVideoInfo(createBiliHttp(), REF, siteCtx(fake));

    assert.deepEqual(result, PAID);
    assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL, VIEW_URL]);
  });
}

const without = (flag: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(FREE_RIGHTS).filter(([name]) => name !== flag));

// 值写成 undefined 的键序列化时会丢掉，响应里就是缺这一项。
const UNKNOWN_MARKS: readonly (readonly [string, Record<string, unknown>])[] = [
  ["缺 rights.pay", { rights: without("pay") }],
  ["缺 rights.ugc_pay", { rights: without("ugc_pay") }],
  ["缺 rights.arc_pay", { rights: without("arc_pay") }],
  ["缺 is_upower_exclusive", { is_upower_exclusive: undefined }],
  ["标记是字符串", { rights: { ...FREE_RIGHTS, pay: "0" } }],
  ["充电标记是字符串", { is_upower_exclusive: "false" }],
  ["标记是 null", { rights: { ...FREE_RIGHTS, ugc_pay: null } }],
  ["充电标记是 null", { is_upower_exclusive: null }],
  ["标记是对象", { rights: { ...FREE_RIGHTS, arc_pay: {} } }],
  ["rights 是空对象", { rights: {} }],
  ["rights 是数组", { rights: [] }],
  ["rights 缺失", { rights: undefined }],
  ["rights 是 null", { rights: null }],
  ["rights 是数字", { rights: 1 }],
  ["rights 是字符串", { rights: "pay" }],
];

for (const [label, marks] of UNKNOWN_MARKS) {
  test(`付费状态确认不了（${label}）：报 UNPLAYABLE，不按免费处理，后面的请求都不发`, async () => {
    const fake = site(() => json(200, viewEnvelope(marks)));

    const result = await readVideoInfo(createBiliHttp(), REF, siteCtx(fake));

    assert.deepEqual(result, PAID_UNKNOWN);
    assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL, VIEW_URL]);
  });
}

test("视频信息不是普通对象时也按确认不了处理", () => {
  for (const data of [null, undefined, 1, "view", [viewData()]]) {
    assert.deepEqual(parseVideoInfo(data, REF), PAID_UNKNOWN, JSON.stringify(data));
  }
});

test("付费判断：四个标记都读到、都是 0 或 false 才算免费", () => {
  assert.equal(paidStatus(viewData()), "free");
  assert.equal(paidStatus({ rights: { pay: false, ugc_pay: false, arc_pay: false }, is_upower_exclusive: 0 }), "free");
  assert.equal(paidStatus({ rights: { ...FREE_RIGHTS, pay: -0 }, is_upower_exclusive: false }), "free");
  assert.equal(value(parseVideoInfo(viewData(), REF)).mediaVersion, "2002");
});

test("付费判断：任一标记为真就算付费，不管别的标记在不在", () => {
  assert.equal(paidStatus({ rights: { pay: 1 } }), "paid");
  assert.equal(paidStatus({ rights: { ...FREE_RIGHTS, arc_pay: -1 }, is_upower_exclusive: false }), "paid");
  assert.equal(paidStatus({ is_upower_exclusive: true }), "paid", "没有 rights 也认充电专属");
  assert.equal(paidStatus({ rights: [], is_upower_exclusive: 1 }), "paid");
});

test("付费判断：标记缺了、写法不对、不是有限数字时一律确认不了", () => {
  const free = { rights: FREE_RIGHTS, is_upower_exclusive: false };
  assert.equal(paidStatus({ rights: FREE_RIGHTS }), "unknown", "缺充电标记");
  assert.equal(paidStatus({ is_upower_exclusive: false }), "unknown", "缺 rights");
  for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, "1", "true", null, {}, [], undefined]) {
    assert.equal(paidStatus({ ...free, rights: { ...FREE_RIGHTS, pay: odd } }), "unknown", String(odd));
    assert.equal(paidStatus({ ...free, is_upower_exclusive: odd }), "unknown", String(odd));
  }
  assert.equal(paidStatus({ ...free, rights: Object.assign([], FREE_RIGHTS) }), "unknown", "rights 是带键的数组");
  assert.equal(paidStatus(null), "unknown");
  assert.equal(paidStatus([free]), "unknown");
});

test("视频不存在和没有权限各报各的错误码", async () => {
  const cases = [
    [-404, "NOT_FOUND"],
    [-403, "UNPLAYABLE"],
  ] as const;
  for (const [code, expected] of cases) {
    const result = failure(await readVideoInfo(createBiliHttp(), REF, siteCtx(site(() => json(200, { code })))));
    assert.equal(result.code, expected);
  }
});

test("未登录时不请求视频信息", async () => {
  const fake = fakeSite({ [NAV_URL]: () => json(200, { code: -101 }) });

  const result = failure(await readVideoInfo(createBiliHttp(), REF, siteCtx(fake)));

  assert.equal(result.code, "NEED_LOGIN");
  assert.deepEqual(fake.requests.map((request) => request.endpoint), [NAV_URL]);
});
