// B 站播放页：页面用结构替身代替，这里只看地址比对、等待和挂载点，渲染留给无头 Chrome。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBilibiliPage } from "../../../../src/sites/bilibili/page.ts";
import type { MainVideo } from "../../../../src/sites/page-types.ts";
import { bilibiliRules } from "../../../../src/sites/bilibili/url.ts";
import { nextTurn } from "../../../helpers/deferred.ts";

const WATCH_URL = "https://www.bilibili.com/video/BV1Sample000";
const OTHER_URL = "https://www.bilibili.com/video/BV1Sample001";
const SERVER_RENDERED = "[data-server-rendered]";

interface FakeNode {
  tagName: string;
  children: FakeNode[];
  parentElement: FakeNode | null;
  firstChild: FakeNode | null;
  nextSibling: FakeNode | null;
}

function node(tagName: string, children: FakeNode[] = []): FakeNode {
  const self: FakeNode = { tagName, children, parentElement: null, firstChild: children[0] ?? null, nextSibling: null };
  children.forEach((child, index) => {
    child.parentElement = self;
    child.nextSibling = children[index + 1] ?? null;
  });
  return self;
}

class FakeDocument extends EventTarget {
  hidden = false;
  readyState = "complete";
  listeners = 0;
  readonly matches = new Map<string, FakeNode>();
  readonly margins = new Map<FakeNode, string>();
  readonly defaultView = {
    getComputedStyle: (element: FakeNode) => ({ marginTop: this.margins.get(element) ?? "0px" }),
  };

  querySelector(selector: string): FakeNode | null {
    return this.matches.get(selector) ?? null;
  }

  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.listeners += 1;
    super.addEventListener(...args);
  }

  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>): void {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }
}

interface Wait {
  ms: number;
  resolve: () => void;
}

function pageWith(href = WATCH_URL) {
  const document = new FakeDocument();
  const location = { href };
  const running = new Set<() => void>();
  const waits: Wait[] = [];
  const page = createBilibiliPage({
    document: document as unknown as Document,
    location,
    every: (_ms, run) => {
      running.add(run);
      return () => running.delete(run);
    },
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        waits.push({ ms, resolve });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const tick = (): void => {
    for (const run of running) run();
  };
  return { page, document, location, running, waits, tick };
}

// 替身之间结构相同，所以挂载点按身份比。
function assertSlot(slot: { parent: Element; before: Node | null } | null | undefined, parent: FakeNode, before: FakeNode | null): void {
  assert.ok(slot);
  assert.equal(slot.parent as unknown, parent);
  assert.equal(slot.before as unknown, before);
}

function assertFound(video: MainVideo, expected: FakeNode): void {
  assert.equal(video.status, "found");
  assert.equal(video.status === "found" ? (video.video as unknown) : null, expected);
}

test("实现播放页契约：用 B 站的地址规则和笔记快捷键", () => {
  const { page } = pageWith();
  assert.equal(page.rules, bilibiliRules);
  assert.equal(page.noteShortcut, "n");
});

test("当前视频只看地址：播放页认得出，别的页面报 null", () => {
  const { page, location } = pageWith(`${WATCH_URL}?p=2`);
  assert.deepEqual(page.currentRef(), { platform: "bilibili", videoId: "BV1Sample000", segment: 2 });
  location.href = "https://www.bilibili.com/";
  assert.equal(page.currentRef(), null);
});

test("订阅时不回调当前视频，换了视频才回调", () => {
  const { page, location, tick } = pageWith();
  const seen: unknown[] = [];
  page.onVideoChange((ref) => seen.push(ref));

  tick();
  assert.deepEqual(seen, []);

  location.href = OTHER_URL;
  tick();
  tick();
  assert.deepEqual(seen, [{ platform: "bilibili", videoId: "BV1Sample001", segment: 1 }]);
});

test("换分 P 算换视频，追踪参数和起播时间不算", () => {
  const { page, location, tick } = pageWith();
  const seen: unknown[] = [];
  page.onVideoChange((ref) => seen.push(ref));

  location.href = `${WATCH_URL}?t=30&from=sample`;
  tick();
  assert.deepEqual(seen, []);

  location.href = `${WATCH_URL}?p=2`;
  tick();
  assert.deepEqual(seen, [{ platform: "bilibili", videoId: "BV1Sample000", segment: 2 }]);
});

test("离开播放页时回调 null，回来时再回调一次", () => {
  const { page, location, tick } = pageWith();
  const seen: unknown[] = [];
  page.onVideoChange((ref) => seen.push(ref));

  location.href = "https://www.bilibili.com/";
  tick();
  location.href = WATCH_URL;
  tick();
  assert.deepEqual(seen, [null, { platform: "bilibili", videoId: "BV1Sample000", segment: 1 }]);
});

test("标签页隐藏时不查地址，切回来立刻补查一次", () => {
  const { page, document, location, tick } = pageWith();
  const seen: unknown[] = [];
  page.onVideoChange((ref) => seen.push(ref));

  document.hidden = true;
  location.href = OTHER_URL;
  tick();
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(seen, []);

  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(seen, [{ platform: "bilibili", videoId: "BV1Sample001", segment: 1 }]);
});

test("退订以后不再回调，定时和监听都摘掉", () => {
  const { page, document, location, running } = pageWith();
  const seen: unknown[] = [];
  const stop = page.onVideoChange((ref) => seen.push(ref));
  assert.equal(running.size, 1);
  assert.equal(document.listeners, 1);

  stop();
  assert.equal(running.size, 0);
  assert.equal(document.listeners, 0);
  location.href = OTHER_URL;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(seen, []);
});

test("等页面加载完、服务端渲染的标记消失，再等 1.2 秒才放行", async () => {
  const { page, document, waits } = pageWith();
  document.readyState = "loading";
  document.matches.set(SERVER_RENDERED, node("DIV"));
  let ready = false;
  const done = page.whenPageReady(new AbortController().signal).then(() => {
    ready = true;
  });
  const pending = (): number[] => waits.map((wait) => wait.ms);
  const finishWait = async (): Promise<void> => {
    waits.shift()?.resolve();
    await nextTurn();
  };

  await nextTurn();
  assert.deepEqual(pending(), [200], "页面还在加载");

  document.readyState = "complete";
  await finishWait();
  assert.deepEqual(pending(), [200], "加载完了，标记还在");

  document.matches.delete(SERVER_RENDERED);
  await finishWait();
  assert.deepEqual(pending(), [1200], "标记没了，再留一点余量");
  assert.equal(ready, false);

  await finishWait();
  await done;
  assert.equal(ready, true);
});

test("页面还在加载时，就算没有服务端渲染的标记也要等", async () => {
  const { page, document, waits } = pageWith();
  document.readyState = "interactive";
  const done = page.whenPageReady(new AbortController().signal);
  await nextTurn();
  assert.deepEqual(waits.map((wait) => wait.ms), [200]);

  document.readyState = "complete";
  waits.shift()?.resolve();
  await nextTurn();
  assert.deepEqual(waits.map((wait) => wait.ms), [1200]);
  waits.shift()?.resolve();
  await done;
});

test("页面早就激活完时也等足 1.2 秒", async () => {
  const { page, waits } = pageWith();
  const done = page.whenPageReady(new AbortController().signal);
  await nextTurn();
  assert.deepEqual(waits.map((wait) => wait.ms), [1200]);
  waits.shift()?.resolve();
  await done;
});

test("迟迟等不到激活也不放行，只有中止才结束", async () => {
  const { page, document, waits } = pageWith();
  document.matches.set(SERVER_RENDERED, node("DIV"));
  const controller = new AbortController();
  const done = page.whenPageReady(controller.signal);

  for (let round = 0; round < 50; round += 1) {
    await nextTurn();
    waits.shift()?.resolve();
  }
  await nextTurn();
  assert.equal(waits.length, 1, "还在等");

  controller.abort();
  await assert.rejects(done, { name: "AbortError" });
});

test("不注入时用真实定时器：到点才查，到点才放行，中止时拒绝", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const document = new FakeDocument();
  const location = { href: WATCH_URL };
  const page = createBilibiliPage({ document: document as unknown as Document, location });

  const seen: unknown[] = [];
  const stop = page.onVideoChange((ref) => seen.push(ref));
  location.href = OTHER_URL;
  t.mock.timers.tick(799);
  assert.deepEqual(seen, []);
  t.mock.timers.tick(1);
  assert.equal(seen.length, 1);
  stop();
  location.href = WATCH_URL;
  t.mock.timers.tick(800);
  assert.equal(seen.length, 1, "退订后定时器停了");

  let ready = false;
  const done = page.whenPageReady(new AbortController().signal).then(() => {
    ready = true;
  });
  t.mock.timers.tick(1199);
  await nextTurn();
  assert.equal(ready, false);
  t.mock.timers.tick(1);
  await done;

  const controller = new AbortController();
  const stopped = page.whenPageReady(controller.signal);
  controller.abort();
  await assert.rejects(stopped, { name: "AbortError" });
  await assert.rejects(page.whenPageReady(controller.signal), { name: "AbortError" }, "已经中止的不再等");
});

test("主视频优先取播放器里的，没有时取页面上的，一个都没有报 none", () => {
  const { page, document } = pageWith();
  assert.deepEqual(page.findMainVideo(), { status: "none" });

  const anywhere = node("VIDEO");
  document.matches.set("video", anywhere);
  assertFound(page.findMainVideo(), anywhere);

  const inPlayer = node("VIDEO");
  document.matches.set(".bpx-player-video-wrap video", inPlayer);
  assertFound(page.findMainVideo(), inPlayer);
});

test("悬停图标的挂载点跳过直接包着视频的那层，取下一个候选", () => {
  const { page, document } = pageWith();
  const wrap = node("DIV", [node("VIDEO")]);
  const outer = node("DIV", [wrap]);
  document.matches.set("#bilibili-player .bpx-player-primary-area", wrap);
  document.matches.set("#bilibili-player", outer);
  assert.equal(page.hoverIconAnchor(), outer);
});

test("悬停图标的候选都直接包着视频或都不在时没有挂载点", () => {
  const { page, document } = pageWith();
  assert.equal(page.hoverIconAnchor(), null);
  document.matches.set("#bilibili-player", node("DIV", [node("VIDEO")]));
  document.matches.set("#playerWrap", node("DIV", [node("DIV"), node("VIDEO")]));
  assert.equal(page.hoverIconAnchor(), null);
});

test("卡片插槽在弹幕列表前面", () => {
  const { page, document } = pageWith();
  const anchor = node("DIV");
  const column = node("DIV", [node("DIV"), anchor, node("DIV")]);
  document.matches.set(".danmaku-box", anchor);
  assertSlot(page.cardSlot?.(), column, anchor);
});

test("弹幕列表被推到视频下面时，卡片插槽在它后面", () => {
  const { page, document } = pageWith();
  const anchor = node("DIV");
  const after = node("DIV");
  const column = node("DIV", [anchor, after]);
  document.matches.set("#danmukuBox", anchor);
  document.margins.set(anchor, "480px");
  assertSlot(page.cardSlot?.(), column, after);
});

test("弹幕列表是右栏最后一个节点时，卡片插槽排在最后", () => {
  const { page, document } = pageWith();
  const anchor = node("DIV");
  const column = node("DIV", [anchor]);
  document.matches.set("#danmukuBox", anchor);
  document.margins.set(anchor, "480px");
  assertSlot(page.cardSlot?.(), column, null);
});

test("没有弹幕列表时卡片插槽在右栏最上面，右栏依次找", () => {
  const { page, document } = pageWith();
  assert.equal(page.cardSlot?.(), null);

  const first = node("DIV");
  const legacy = node("DIV", [first]);
  document.matches.set(".r-con", legacy);
  assertSlot(page.cardSlot?.(), legacy, first);

  const empty = node("DIV");
  document.matches.set(".playlist-container--right", empty);
  assertSlot(page.cardSlot?.(), empty, null);
});
