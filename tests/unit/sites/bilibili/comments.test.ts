// 评论区：解析只看自造的响应，读取走严格替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMENT_LIMIT, COMMENT_MAX_CHARS, parseTopComments, readTopComments } from "../../../../src/sites/bilibili/comments.ts";
import { REPLY_URL, VIEW_URL, type BiliHttp, type GetRequest } from "../../../../src/sites/bilibili/http.ts";
import type { SiteCtx, SiteResult, VideoInfo } from "../../../../src/sites/types.ts";
import { failure, value } from "../../../helpers/bilibili-fetch.ts";

const INFO: VideoInfo = {
  ref: { platform: "bilibili", videoId: "BV1Sample001", segment: 1 },
  title: "样例视频",
  author: "样例作者",
  description: "",
  durationSec: 600,
  mediaVersion: "2001",
  siteRef: "1001",
};

const reply = (rpid: number, message: unknown, like: unknown = 0, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  rpid,
  like,
  content: { message },
  member: { uname: "样例昵称", mid: 9 },
  ...extra,
});

function fakeHttp(answer: SiteResult<unknown>): { http: BiliHttp; requests: GetRequest[] } {
  const requests: GetRequest[] = [];
  const http = {
    getData: (request: GetRequest) => {
      requests.push(request);
      return Promise.resolve(answer);
    },
  } as unknown as BiliHttp;
  return { http, requests };
}

const CTX = {} as SiteCtx;

test("置顶的排前面，置顶和热评里重复的那条只留置顶那份", () => {
  const comments = value(
    parseTopComments({
      top_replies: [reply(1, "置顶的一条", 5)],
      replies: [reply(2, "热评一", 300), reply(1, "置顶的一条", 5), reply(3, "热评二", "17")],
    }),
  );
  assert.deepEqual(comments, [
    { text: "置顶的一条", likes: 5, pinned: true },
    { text: "热评一", likes: 300, pinned: false },
    { text: "热评二", likes: 17, pinned: false },
  ]);
});

test("不带昵称和评论者身份", () => {
  const [comment] = value(parseTopComments({ replies: [reply(1, "一条评论", 1)] }));
  assert.deepEqual(Object.keys(comment ?? {}).sort(), ["likes", "pinned", "text"]);
});

test("空正文、隐藏的、正文不是文字的跳过；点赞数读不懂按 0", () => {
  const comments = value(
    parseTopComments({
      replies: [reply(1, "   "), reply(2, "隐藏的", 9, { invisible: true }), reply(3, 42), reply(4, "留下的", "很多"), null],
    }),
  );
  assert.deepEqual(comments, [{ text: "留下的", likes: 0, pinned: false }]);
});

test("最多交出第一页那么多条，单条正文截到上限", () => {
  const many = Array.from({ length: COMMENT_LIMIT + 5 }, (_, index) => reply(index + 1, `评论${index}`));
  assert.equal(value(parseTopComments({ replies: many })).length, COMMENT_LIMIT);
  const [long] = value(parseTopComments({ replies: [reply(1, "长".repeat(COMMENT_MAX_CHARS + 10))] }));
  assert.equal(long?.text.length, COMMENT_MAX_CHARS);
});

test("没有评论时是空列表；列表位置不是列表时报内容格式不对", () => {
  assert.deepEqual(value(parseTopComments({ replies: null })), []);
  assert.deepEqual(value(parseTopComments({})), []);
  const broken = failure(parseTopComments({ replies: "x" }));
  assert.equal(broken.code, "MALFORMED");
  assert.equal(failure(parseTopComments(null)).code, "MALFORMED");
});

test("读一次：按视频的 av 号、视频评论、热度排序，不带签名、不翻页", async () => {
  const { http, requests } = fakeHttp({ ok: true, value: { replies: [reply(1, "一条", 2)] } });
  const comments = value(await readTopComments(http, INFO, CTX));
  assert.equal(comments.length, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { url: REPLY_URL, params: { oid: "1001", type: "1", mode: "3" } });
});

test("请求出口报失败时照实交回，不另外再试", async () => {
  const { http, requests } = fakeHttp({ ok: false, code: "RATE_LIMITED", retryAfterSec: 60 });
  assert.equal(failure(await readTopComments(http, INFO, CTX)).code, "RATE_LIMITED");
  assert.equal(requests.length, 1);
});

test("视频信息里没有 av 号时先读视频信息；视频信息读不成（比如付费）就不读评论", async () => {
  const { http, requests } = fakeHttp({ ok: false, code: "UNPLAYABLE", detail: "paid" });
  const { siteRef: _dropped, ...withoutNumber } = INFO;
  assert.equal(failure(await readTopComments(http, withoutNumber, CTX)).code, "UNPLAYABLE");
  assert.deepEqual(requests.map((request) => request.url), [VIEW_URL]);
});
