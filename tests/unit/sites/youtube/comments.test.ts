// YouTube 评论区：页面用结构替身代替，样例全是自造的。核对只读页面上已有的、不读评论者身份，
// 只在前台、没在播广告、用户没在动时滚一次，读完滚回去，用户接手了就不滚回去；后台核对页面回的结果。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { PageChannel, SiteCtx, SiteFailure, VideoInfo } from "../../../../src/sites/types.ts";
import { pageCommentReader, type PageAsk } from "../../../../src/sites/youtube/comments.ts";
import { commentReplyOf, likesOf, loadReplyOf } from "../../../../src/sites/youtube/page/comment-types.ts";
import { COMMENT_WAIT_MS, createCommentLoader } from "../../../../src/sites/youtube/page/commands.ts";
import { createCommentReader, loadedComments } from "../../../../src/sites/youtube/page/read-comments.ts";

const ID = "jmSample0001";
const OTHER = "jmSample0002";
const REF: VideoRef = { platform: "youtube", videoId: ID };

class FakeNode {
  readonly attributes = new Map<string, string>();
  readonly found = new Map<string, FakeNode>();
  readonly lists = new Map<string, FakeNode[]>();
  readonly classes = new Set<string>();
  readonly classList = { contains: (name: string) => this.classes.has(name) };
  textContent = "";
  scrolled = 0;
  onScroll: (() => void) | null = null;
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string): FakeNode | null {
    return this.found.get(selector) ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.lists.get(selector) ?? [];
  }
  matches(): boolean {
    return false;
  }
  scrollIntoView(): void {
    this.scrolled += 1;
    this.onScroll?.();
  }
}

function thread(text: string, likes: string, pinned = false): FakeNode {
  const node = new FakeNode();
  const top = new FakeNode();
  const body = new FakeNode();
  body.textContent = text;
  const votes = new FakeNode();
  votes.textContent = likes;
  const badge = new FakeNode();
  badge.textContent = pinned ? "  置顶的标记  " : "";
  const author = new FakeNode();
  author.textContent = "@sample-author";
  top.found.set("#content-text", body);
  top.found.set("#vote-count-middle", votes);
  top.found.set("#pinned-comment-badge", badge);
  top.found.set("#author-text", author);
  node.found.set("#comment-container", top);
  return node;
}

interface FakePage {
  readonly document: Document;
  readonly section: FakeNode;
  readonly view: { scrollX: number; scrollY: number; scrollTo: (x: number, y: number) => void; restored: number };
  readonly listeners: Map<string, () => void>;
  readonly shell: FakeNode;
  readonly player: FakeNode;
  state: { visibility: string; active: FakeNode | null };
}

function fakePage({ threads = [] as FakeNode[], section = true } = {}): FakePage {
  const shell = new FakeNode();
  shell.attributes.set("video-id", ID);
  const player = new FakeNode();
  const comments = new FakeNode();
  comments.lists.set("ytd-comment-thread-renderer", threads);
  const listeners = new Map<string, () => void>();
  const view = {
    scrollX: 0,
    scrollY: 120,
    restored: 0,
    scrollTo(x: number, y: number) {
      view.scrollX = x;
      view.scrollY = y;
      view.restored += 1;
    },
  };
  const state = { visibility: "visible", active: null as FakeNode | null };
  const document = {
    defaultView: view,
    get visibilityState() {
      return state.visibility;
    },
    get activeElement() {
      return state.active;
    },
    querySelector(selector: string) {
      if (selector === "ytd-watch-flexy") return shell;
      if (selector === "ytd-watch-flexy .html5-video-player") return player;
      if (selector === "ytd-comments#comments") return section ? comments : null;
      return null;
    },
    addEventListener(type: string, listener: () => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) {
      listeners.delete(type);
    },
  } as unknown as Document;
  return { document, section: comments, view, listeners, shell, player, state };
}

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let at = 0;
  return { now: () => at, sleep: async (ms) => void (at += ms) };
}

test("点赞数：缩写、千分位、中文单位和逗号小数点都认得，认不出的按 0", () => {
  assert.equal(likesOf("357"), 357);
  assert.equal(likesOf("73K"), 73_000);
  assert.equal(likesOf("1.2M"), 1_200_000);
  assert.equal(likesOf("2,462"), 2_462);
  assert.equal(likesOf("1,2 k"), 1_200);
  assert.equal(likesOf("1.2万"), 12_000);
  assert.equal(likesOf("3亿"), 300_000_000);
  assert.equal(likesOf(""), 0);
  assert.equal(likesOf("赞"), 0);
  assert.equal(likesOf(null), 0);
});

test("页面上已加载的评论：读正文、点赞数和置顶，不读昵称，最多 20 条", () => {
  const page = fakePage({ threads: [thread("  置顶的样例  评论 ", "12", true), thread("样例热评", "1.5K"), thread("   ", "3")] });
  assert.deepEqual(loadedComments(page.document), [
    { text: "置顶的样例 评论", likes: 12, pinned: true },
    { text: "样例热评", likes: 1500, pinned: false },
  ]);
  const many = fakePage({ threads: Array.from({ length: 25 }, (_, index) => thread(`评论${index}`, "1")) });
  assert.equal(loadedComments(many.document).length, 20);
});

test("读评论：页面上不是问的那个视频时不交评论", async () => {
  const page = fakePage({ threads: [thread("样例热评", "5")] });
  const reader = createCommentReader({ document: page.document, currentRef: () => REF });
  assert.deepEqual(await reader.handle({ type: "youtube.comments", req: { videoId: ID } }), { videoId: ID, comments: [{ text: "样例热评", likes: 5, pinned: false }] });
  assert.deepEqual(await reader.handle({ type: "youtube.comments", req: { videoId: OTHER } }), { videoId: ID, comments: [] });
  assert.equal(reader.handle({ type: "youtube.panel", req: { videoId: ID } }), null);
});

test("滚一次：前台、评论区还没加载时滚过去，等到评论就滚回原处", async () => {
  const page = fakePage();
  page.section.onScroll = () => page.section.lists.set("ytd-comment-thread-renderer", [thread("加载出来的", "1")]);
  const loader = createCommentLoader({ document: page.document, currentRef: () => REF, ...clock() });
  assert.deepEqual(await loader.handle({ type: "youtube.loadComments", req: { videoId: ID } }), { videoId: ID, outcome: "loaded" });
  assert.equal(page.section.scrolled, 1, "只滚一次");
  assert.deepEqual([page.view.scrollX, page.view.scrollY, page.view.restored], [0, 120, 1], "滚回原处");
  assert.equal(page.listeners.size, 0, "等完撤掉监听");
});

test("滚一次：本来就有评论、后台标签页、正在播广告、没有评论区、视频对不上、正在打字时都不滚", async () => {
  const cases: [string, (page: FakePage) => void, string][] = [
    ["已有评论", (page) => page.section.lists.set("ytd-comment-thread-renderer", [thread("已有的", "1")]), "loaded"],
    ["后台", (page) => (page.state.visibility = "hidden"), "hidden"],
    ["广告", (page) => page.player.classes.add("ad-showing"), "ad"],
    ["视频对不上", (page) => page.shell.attributes.set("video-id", OTHER), "video-changed"],
    ["正在打字", (page) => (page.state.active = Object.assign(new FakeNode(), { matches: () => true })), "busy"],
  ];
  for (const [label, arrange, outcome] of cases) {
    const page = fakePage();
    arrange(page);
    const loader = createCommentLoader({ document: page.document, currentRef: () => REF, ...clock() });
    const reply = await loader.handle({ type: "youtube.loadComments", req: { videoId: ID } });
    assert.equal(reply?.outcome, outcome, label);
    assert.equal(page.section.scrolled, 0, `${label}：不滚`);
    assert.equal(page.view.restored, 0, `${label}：不动页面`);
  }
  const bare = fakePage({ section: false });
  const loader = createCommentLoader({ document: bare.document, currentRef: () => REF, ...clock() });
  assert.equal((await loader.handle({ type: "youtube.loadComments", req: { videoId: ID } }))?.outcome, "no-section");
});

test("滚一次：页面正在滚动时当成用户在动，不滚", async () => {
  const page = fakePage();
  const time = clock();
  const loader = createCommentLoader({
    document: page.document,
    currentRef: () => REF,
    now: time.now,
    sleep: async (ms) => {
      page.view.scrollY += 40;
      await time.sleep(ms);
    },
  });
  assert.equal((await loader.handle({ type: "youtube.loadComments", req: { videoId: ID } }))?.outcome, "busy");
  assert.equal(page.section.scrolled, 0);
});

test("滚一次：等不到评论时报 timeout，照样滚回原处，不再滚第二次", async () => {
  const page = fakePage();
  const time = clock();
  const loader = createCommentLoader({ document: page.document, currentRef: () => REF, ...time });
  assert.equal((await loader.handle({ type: "youtube.loadComments", req: { videoId: ID } }))?.outcome, "timeout");
  assert.ok(time.now() >= COMMENT_WAIT_MS);
  assert.equal(page.section.scrolled, 1);
  assert.equal(page.view.restored, 1);
});

test("滚一次：等的时候用户自己动了页面，不滚回去；换了视频也不滚回去", async () => {
  const touched = fakePage();
  touched.section.onScroll = () => touched.listeners.get("wheel")?.();
  const first = createCommentLoader({ document: touched.document, currentRef: () => REF, ...clock() });
  assert.equal((await first.handle({ type: "youtube.loadComments", req: { videoId: ID } }))?.outcome, "interrupted");
  assert.equal(touched.view.restored, 0);

  const moved = fakePage();
  moved.section.onScroll = () => moved.shell.attributes.set("video-id", OTHER);
  const second = createCommentLoader({ document: moved.document, currentRef: () => REF, ...clock() });
  assert.equal((await second.handle({ type: "youtube.loadComments", req: { videoId: ID } }))?.outcome, "video-changed");
  assert.equal(moved.view.restored, 0);
});

test("核对页面回的结果：字段、类型、条数和视频编号不对的整份不用", () => {
  const good = { videoId: ID, comments: [{ text: "一条", likes: 3, pinned: false }] };
  assert.deepEqual(commentReplyOf(good), good);
  assert.equal(commentReplyOf({ ...good, comments: [{ text: "一条", likes: -1, pinned: false }] }), null);
  assert.equal(commentReplyOf({ ...good, comments: [{ text: "一条", likes: 1, pinned: "yes" }] }), null);
  assert.deepEqual(commentReplyOf({ ...good, comments: [{ text: "一条", likes: 1, pinned: false, author: "x" }] }), { videoId: ID, comments: [{ text: "一条", likes: 1, pinned: false }] }, "多出来的字段不往下传");
  assert.equal(commentReplyOf({ ...good, comments: Array.from({ length: 21 }, () => good.comments[0]) }), null);
  assert.equal(commentReplyOf({ ...good, videoId: "bad id!" }), null);
  assert.deepEqual(loadReplyOf({ videoId: ID, outcome: "loaded" }), { videoId: ID, outcome: "loaded" });
  assert.equal(loadReplyOf({ videoId: ID, outcome: "clicked" }), null);
});

const INFO: VideoInfo = { ref: REF, title: "样例", author: "样例频道", description: "", durationSec: 600 };

function scriptedAsk(answers: Record<string, unknown[]>): { ask: PageAsk; asked: string[] } {
  const asked: string[] = [];
  const ask: PageAsk = async (_page, message) => {
    const type = (message as { type: string }).type;
    asked.push(type);
    const answer = answers[type]?.shift();
    return answer === undefined ? { ok: false, failure: { ok: false, code: "UNAVAILABLE", detail: "no-page" } as SiteFailure } : { ok: true, answer };
  };
  return { ask, asked };
}

const CTX = { page: {} as PageChannel, signal: new AbortController().signal } as SiteCtx;
const ONE = [{ text: "样例热评", likes: 9, pinned: false }];

test("后台：页面上已有评论时直接用，不请页面滚", async () => {
  const { ask, asked } = scriptedAsk({ "youtube.comments": [{ videoId: ID, comments: ONE }] });
  const result = await pageCommentReader(ask)(INFO, CTX);
  assert.deepEqual(result, { ok: true, value: ONE });
  assert.deepEqual(asked, ["youtube.comments"]);
});

test("后台：页面上没有时请页面滚一次，加载出来再读一遍", async () => {
  const { ask, asked } = scriptedAsk({
    "youtube.comments": [{ videoId: ID, comments: [] }, { videoId: ID, comments: ONE }],
    "youtube.loadComments": [{ videoId: ID, outcome: "loaded" }],
  });
  assert.deepEqual(await pageCommentReader(ask)(INFO, CTX), { ok: true, value: ONE });
  assert.deepEqual(asked, ["youtube.comments", "youtube.loadComments", "youtube.comments"]);
});

test("后台：滚不成时报读不到并写明原因，不再试；视频对不上单独报；结果形状不对报内容格式不对", async () => {
  const hidden = scriptedAsk({ "youtube.comments": [{ videoId: ID, comments: [] }], "youtube.loadComments": [{ videoId: ID, outcome: "hidden" }] });
  const failed = await pageCommentReader(hidden.ask)(INFO, CTX);
  assert.deepEqual(failed, { ok: false, code: "UNAVAILABLE", detail: "comments-hidden" });
  assert.deepEqual(hidden.asked, ["youtube.comments", "youtube.loadComments"]);

  const changed = scriptedAsk({ "youtube.comments": [{ videoId: OTHER, comments: ONE }] });
  assert.deepEqual(await pageCommentReader(changed.ask)(INFO, CTX), { ok: false, code: "VIDEO_CHANGED", detail: "comments" });

  const broken = scriptedAsk({ "youtube.comments": [{ videoId: ID, comments: "x" }] });
  const result = await pageCommentReader(broken.ask)(INFO, CTX);
  assert.equal(result.ok ? "" : result.code, "MALFORMED");

  assert.deepEqual(await pageCommentReader(scriptedAsk({}).ask)(INFO, { ...CTX, page: undefined } as unknown as SiteCtx), { ok: false, code: "UNAVAILABLE", detail: "no-page" });
});
