// 稍后再看列表：请求走严格替身，响应都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { NAV_URL, WATCH_LATER_URL, type BiliHttp, type GetRequest } from "../../../../src/sites/bilibili/http.ts";
import { parseWatchLater, parseWatchLaterItem, readWatchLater } from "../../../../src/sites/bilibili/watch-later.ts";
import { rig } from "../../../helpers/bilibili-captions.ts";
import { failure, hanging, value, type Route } from "../../../helpers/bilibili-fetch.ts";
import { BAN_RESPONSES, json, navLoggedOut } from "../../../helpers/bilibili-fixtures.ts";

const FIRST_ID = "BV1Sample001";
const SECOND_ID = "BV1Sample002";

type RawItem = Record<string, unknown>;

function sampleItems(): [RawItem, RawItem] {
  return [
    {
      videos: 1,
      pic: "http://i0.hdslb.com/bfs/archive/sample-one.jpg",
      title: "样例视频一",
      desc: "样例简介一",
      state: 0,
      duration: 218,
      owner: { mid: 3003, name: "样例作者" },
      page: { cid: 2002, page: 1, part: "样例分 P", duration: 218 },
      count: 1,
      cid: 2002,
      progress: 32,
      add_at: 1800000100,
      bvid: FIRST_ID,
      rights: { pay: 0, ugc_pay: 0, arc_pay: 0 },
      is_upower_exclusive: false,
    },
    {
      videos: 1,
      pic: "http://i0.hdslb.com/bfs/archive/sample-two.jpg",
      title: "样例视频二",
      desc: "样例简介二",
      state: 0,
      duration: 169,
      owner: { mid: 3004, name: "另一位样例作者" },
      count: 1,
      cid: 0,
      progress: 0,
      add_at: 1800000200,
      bvid: SECOND_ID,
    },
  ];
}

const listEnvelope = (list: readonly unknown[] = sampleItems(), count = 25): unknown => ({ code: 0, data: { count, list } });
const okList: Route = () => json(200, listEnvelope());

function item(raw: RawItem): NonNullable<ReturnType<typeof parseWatchLaterItem>> {
  const parsed = parseWatchLaterItem(raw);
  assert.ok(parsed);
  return parsed;
}

test("每项取出 BV 号、cid、封面、标题、UP 主、时长和观看进度", () => {
  const result = value(parseWatchLater({ count: 25, list: sampleItems() }));

  assert.equal(result.total, 25, "总数用平台报的数，界面据此提示没回全");
  assert.equal(result.dropped, 0);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    videoKey: `bilibili:${FIRST_ID}:p1`,
    title: "样例视频一",
    ownerName: "样例作者",
    channel: { platform: "bilibili", channelId: "3003" },
    mediaVersion: "2002",
    duration: 218,
    progress: 32,
    finished: false,
    pageCount: 1,
    available: true,
    cover: "https://i0.hdslb.com/bfs/archive/sample-one.jpg",
    description: "样例简介一",
    addedAt: 1800000100,
    paidChecked: true,
  });
  assert.equal(result.items[1]?.mediaVersion, undefined, "两处都没有时不填，读官方总结前再查视频信息");
  assert.equal(result.items[1]?.progress, 0);
});

test("cid 为 0 时退到 page.cid", () => {
  const [first] = sampleItems();
  assert.equal(item({ ...first, cid: 0 }).mediaVersion, "2002");
});

test("字段缺失：没有封面、UP 主、时长、进度、state 时给安全的默认值", () => {
  assert.deepEqual(item({ bvid: FIRST_ID }), {
    videoKey: `bilibili:${FIRST_ID}:p1`,
    title: "",
    ownerName: "",
    duration: 0,
    progress: 0,
    finished: false,
    pageCount: 1,
    available: true,
    cover: "",
    description: "",
    addedAt: 0,
    paidChecked: false,
  });
});

test("progress 为 -1 记成已看完；负数 state 标成看不了", () => {
  const [first] = sampleItems();
  const finished = item({ ...first, progress: -1 });
  assert.equal(finished.finished, true);
  assert.equal(finished.progress, 0);

  for (const state of [-1, -4, -100]) {
    assert.equal(item({ ...first, state }).available, false, `state ${state}`);
  }
  assert.equal(item({ ...first, state: 1 }).available, true);
});

test("封面只认 http(s) 和协议相对地址，其余协议一律丢掉", () => {
  const [first] = sampleItems();
  const cover = (pic: unknown): string => item({ ...first, pic }).cover;
  assert.equal(cover("//i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg");
  assert.equal(cover("https://i0.hdslb.com/a.jpg"), "https://i0.hdslb.com/a.jpg");
  assert.equal(cover("javascript:alert(1)"), "");
  assert.equal(cover("data:image/png;base64,AAAA"), "");
  assert.equal(cover("ftp://i0.hdslb.com/a.jpg"), "");
  assert.equal(cover(42), "");
});

test("缺 BV 号或 BV 号不合法的项丢掉，重复的只留第一个，计入 dropped", () => {
  const [first, second] = sampleItems();
  const result = value(
    parseWatchLater({
      count: 5,
      list: [first, { ...second, bvid: "" }, { ...second, bvid: "BV123" }, first, second],
    }),
  );

  assert.deepEqual(
    result.items.map((entry) => entry.videoKey),
    [`bilibili:${FIRST_ID}:p1`, `bilibili:${SECOND_ID}:p1`],
  );
  assert.equal(result.dropped, 3);
  assert.equal(parseWatchLaterItem(null), null);
  assert.equal(parseWatchLaterItem({ bvid: `x${FIRST_ID}` }), null, "只认整串都是视频号的");
});

test("列表为空：list 为 null 或缺失都按空列表算", () => {
  for (const data of [{ count: 0, list: null }, { count: 0 }]) {
    const result = value(parseWatchLater(data));
    assert.deepEqual(result.items, []);
    assert.equal(result.total, 0);
    assert.equal(result.dropped, 0);
  }
});

test("未登录 -101 报 NEED_LOGIN；其余错误码和坏结构报 MALFORMED", async () => {
  const read = async (body: unknown): Promise<ReturnType<typeof failure>> => {
    const { http, ctx } = rig({ [WATCH_LATER_URL]: () => json(200, body) });
    return failure(await readWatchLater(http, ctx));
  };

  assert.equal((await read({ code: -101, message: "sample refusal" })).code, "NEED_LOGIN");

  const badRequest = await read({ code: -400, message: "sample refusal" });
  assert.equal(badRequest.code, "MALFORMED");
  assert.equal(badRequest.detail, "code:-400");

  assert.equal((await read(null)).code, "MALFORMED");
  assert.equal((await read({ message: "没有业务码" })).code, "MALFORMED");
  assert.equal((await read({ code: 0 })).code, "MALFORMED");
});

test("只发一个不带参数的 GET，带登录 cookie", async () => {
  const { http, ctx, fake } = rig({ [WATCH_LATER_URL]: okList });

  value(await readWatchLater(http, ctx));

  const calls = fake.calls(WATCH_LATER_URL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, WATCH_LATER_URL);
  assert.equal(calls[0]?.init.method, undefined, "默认 GET，不是会改数据的 POST");
  assert.equal(calls[0]?.init.body, undefined);
  assert.equal(calls[0]?.init.credentials, "include");
  assert.equal(calls[0]?.init.cache, "no-store");
});

test("未登录、HTTP 错误、网络失败、坏 JSON 都按 SiteResult 报，不抛错", async () => {
  const loggedOut = rig({ [NAV_URL]: () => json(200, navLoggedOut()) });
  assert.equal(failure(await readWatchLater(loggedOut.http, loggedOut.ctx)).code, "NEED_LOGIN");
  assert.equal(loggedOut.fake.calls(WATCH_LATER_URL).length, 0, "登录门挡在内容请求前面");

  const broken = rig({ [WATCH_LATER_URL]: () => json(503, {}) });
  const http = failure(await readWatchLater(broken.http, broken.ctx));
  assert.equal(http.code, "NETWORK");
  assert.equal(http.detail, "http:503");

  const dropped = rig({
    [WATCH_LATER_URL]: () => {
      throw new TypeError("sample failure");
    },
  });
  assert.equal(failure(await readWatchLater(dropped.http, dropped.ctx)).code, "NETWORK");

  const malformed = rig({ [WATCH_LATER_URL]: () => new Response("{", { status: 200 }) });
  assert.equal(failure(await readWatchLater(malformed.http, malformed.ctx)).code, "MALFORMED");
  assert.equal(malformed.backoff.trips.length, 1, "接口主机回的不是 JSON 要进退避");
});

test("迟迟不回时按时放手，报 TIMEOUT，并中止请求", async () => {
  const { http, ctx, fake } = rig({ [WATCH_LATER_URL]: hanging });

  const result = failure(await readWatchLater(http, ctx, { timeoutMs: 20 }));

  assert.equal(result.code, "TIMEOUT");
  assert.equal(fake.calls(WATCH_LATER_URL)[0]?.init.signal?.aborted, true);
});

for (const [label, ban] of BAN_RESPONSES) {
  test(`稍后再看：${label} 时报 RATE_LIMITED`, async () => {
    const { http, ctx, fake, backoff } = rig({ [WATCH_LATER_URL]: ban });

    assert.equal(failure(await readWatchLater(http, ctx)).code, "RATE_LIMITED");

    assert.equal(backoff.trips.length, 1);
    assert.equal(fake.calls(WATCH_LATER_URL).length, 1, "不重发");
  });
}

test("付费和充电专属的项标成看不了，这一条读到了付费标记", () => {
  const [first] = sampleItems();
  const paidItems: readonly RawItem[] = [
    { ...first, rights: { pay: 1 } },
    { ...first, rights: { ugc_pay: 1 } },
    { ...first, rights: { arc_pay: 1 } },
    { ...first, is_upower_exclusive: true },
    { ...first, rights: { pay: 0, ugc_pay: true, arc_pay: 0 } },
    { ...first, rights: { pay: 2, ugc_pay: "0", arc_pay: null }, is_upower_exclusive: "false" },
  ];

  for (const raw of paidItems) {
    const paid = item(raw);
    assert.equal(paid.available, false, JSON.stringify(raw));
    assert.equal(paid.paidChecked, true, JSON.stringify(raw));
  }
});

test("只带充电专属标记、没有权限对象时也标成看不了", () => {
  const paid = item({ bvid: FIRST_ID, is_upower_exclusive: true });
  assert.equal(paid.available, false);
  assert.equal(paid.paidChecked, true);
});

test("付费标记缺了或写法不对时 paidChecked 为 false，仍算能看；四个都读到且都是假才为 true", () => {
  const [first, second] = sampleItems();

  const checked = item(first);
  assert.equal(checked.paidChecked, true);
  assert.equal(checked.available, true);
  assert.equal(item({ ...first, rights: { pay: false, ugc_pay: false, arc_pay: false } }).paidChecked, true);

  for (const raw of [
    second,
    { ...second, rights: null },
    { ...second, is_upower_exclusive: false },
    { ...second, rights: {}, is_upower_exclusive: false },
    { ...second, rights: [], is_upower_exclusive: false },
    { ...second, rights: { pay: 0, ugc_pay: 0, arc_pay: 0 } },
    { ...first, rights: { pay: 0, ugc_pay: 0 } },
    { ...first, rights: { pay: "0", ugc_pay: 0, arc_pay: 0 } },
    { ...first, rights: { pay: 0, ugc_pay: null, arc_pay: 0 } },
    { ...first, rights: { pay: 0, ugc_pay: 0, arc_pay: {} } },
    { ...first, is_upower_exclusive: "false" },
    { ...first, is_upower_exclusive: null },
  ]) {
    const unchecked = item(raw);
    assert.equal(unchecked.paidChecked, false, JSON.stringify(raw));
    assert.equal(unchecked.available, true, JSON.stringify(raw));
  }
});

test("多 P 视频按第 1 P 记键，分 P 数取平台报的数", () => {
  const [first] = sampleItems();
  const parts = item({ ...first, videos: 3 });
  assert.equal(parts.videoKey, `bilibili:${FIRST_ID}:p1`);
  assert.equal(parts.pageCount, 3);
});

test("稍后再看默认的时限是 15 秒", async () => {
  const { http, ctx } = rig({ [WATCH_LATER_URL]: okList });
  const seen: GetRequest[] = [];
  const spying: BiliHttp = {
    ...http,
    getData: (request, requestCtx) => {
      seen.push(request);
      return http.getData(request, requestCtx);
    },
  };

  value(await readWatchLater(spying, ctx));

  assert.equal(seen[0]?.timeoutMs, 15_000);
  assert.equal(seen[0]?.signed, undefined, "这个接口不要求签名");
});
