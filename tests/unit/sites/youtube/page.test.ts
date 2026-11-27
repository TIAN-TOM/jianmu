// YouTube 观看页：页面用结构替身代替，这里只看地址比对、站内跳转、广告、挂载点、卡片位置、控制栏和频道，渲染留给无头 Chrome。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createYoutubePage } from "../../../../src/sites/youtube/page.ts";
import { nextTurn } from "../../../helpers/deferred.ts";

// 自造的编号，只照着字符集和长度写，不对应真实视频。
const ID = "jmSample0001";
const OTHER = "jmSample0002";
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

class FakeClassList extends Set<string> {
  contains(name: string): boolean {
    return this.has(name);
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly attributes = new Map<string, string>();
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument extends EventTarget {
  hidden = false;
  readyState = "complete";
  fullscreenElement: FakeElement | null = null;
  readonly matches = new Map<string, FakeElement>();
  readonly lists = new Map<string, FakeElement[]>();
  querySelector(selector: string): FakeElement | null {
    return this.matches.get(selector) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.lists.get(selector) ?? [];
  }
}

function pageAt(href: string) {
  const document = new FakeDocument();
  const location = { href };
  const ticks = new Set<() => void>();
  const observed = new Map<FakeElement, () => void>();
  const player = new FakeElement("DIV");
  const video = new FakeElement("VIDEO");
  const shell = new FakeElement("YTD-WATCH-FLEXY");
  document.matches.set("ytd-app", new FakeElement("YTD-APP"));
  document.matches.set("ytd-watch-flexy .html5-video-player", player);
  document.matches.set("ytd-watch-flexy .html5-video-player video.html5-main-video", video);
  document.matches.set("ytd-watch-flexy", shell);
  const page = createYoutubePage({
    document: document as unknown as Document,
    location,
    sleep: () => nextTurn(),
    every: (_ms, run) => {
      ticks.add(run);
      return () => void ticks.delete(run);
    },
    observeAttribute: (element, _name, run) => {
      observed.set(element as unknown as FakeElement, run);
      return () => void observed.delete(element as unknown as FakeElement);
    },
  });
  return { page, document, location, player, video, shell, tick: () => ticks.forEach((run) => run()), observed };
}

test("只在观看页认得出视频；首页、搜索页认不出，也不找视频和挂载点", () => {
  const home = pageAt("https://www.youtube.com/");
  assert.equal(home.page.currentRef(), null);
  assert.deepEqual(home.page.findMainVideo(), { status: "none" });
  assert.equal(home.page.hoverIconAnchor(), null);

  const watching = pageAt(watch(ID));
  assert.deepEqual(watching.page.currentRef(), { platform: "youtube", videoId: ID });
  assert.equal(watching.page.findMainVideo().status, "found");
  assert.equal(watching.page.hoverIconAnchor(), watching.player as unknown as Element);
  assert.equal(watching.page.noteShortcut, "n");
});

test("播放器标着在播广告时报 ad，不报找不到视频", () => {
  for (const name of ["ad-showing", "ad-interrupting"]) {
    const { page, player } = pageAt(watch(ID));
    player.classList.add(name);
    assert.deepEqual(page.findMainVideo(), { status: "ad" }, name);
  }
});

test("站内跳转完成的事件和定时比地址都能发现换了视频，同一个视频不重复报", () => {
  const { page, document, location, tick } = pageAt(watch(ID));
  const seen: (string | null)[] = [];
  const stop = page.onVideoChange((ref) => seen.push(ref?.videoId ?? null));
  location.href = watch(OTHER);
  document.dispatchEvent(new Event("yt-navigate-finish"));
  tick();
  location.href = "https://www.youtube.com/";
  tick();
  stop();
  location.href = watch(ID);
  document.dispatchEvent(new Event("yt-navigate-finish"));
  assert.deepEqual(seen, [OTHER, null]);
});

test("页面外壳出来、加载完才算激活，不在观看页也一样", async () => {
  const { page, document } = pageAt("https://www.youtube.com/");
  await page.whenPageReady(new AbortController().signal);
  document.readyState = "loading";
  const controller = new AbortController();
  let done = false;
  const waiting = page.whenPageReady(controller.signal).then(() => (done = true));
  await nextTurn();
  assert.equal(done, false);
  document.readyState = "complete";
  await waiting;
  assert.equal(done, true);
});

test("控制栏：播放器藏起控制栏时报看不见，换回来报看得见；不在观看页报没信号", () => {
  const { page, player, observed, location, tick } = pageAt(watch(ID));
  const seen: (boolean | null)[] = [];
  const stop = page.watchControls?.((visible) => seen.push(visible));
  player.classList.add("ytp-autohide");
  observed.get(player)?.();
  player.classList.delete("ytp-autohide");
  observed.get(player)?.();
  location.href = "https://www.youtube.com/";
  tick();
  stop?.();
  assert.deepEqual(seen, [true, false, true, null]);
});

test("频道：外壳上的视频和地址对得上才读，认频道编号和 @ 名，认不出的链接不要", () => {
  const { page, shell, document } = pageAt(watch(ID));
  const channel = new FakeElement("A");
  channel.attributes.set("href", "/channel/UCsample0000000000000001");
  document.lists.set("ytd-watch-metadata ytd-channel-name a", [channel]);
  shell.attributes.set("video-id", OTHER);
  assert.equal(page.channelId?.(), null, "外壳还是上一个视频");
  shell.attributes.set("video-id", ID);
  assert.equal(page.channelId?.(), "UCsample0000000000000001");
  channel.attributes.set("href", "/@sample.channel");
  assert.equal(page.channelId?.(), "@sample.channel");
  channel.attributes.set("href", "https://other.example/channel/UCsample");
  assert.equal(page.channelId?.(), null);
});

// ============================================================
// 卡片的位置：右栏推荐视频上面，侧栏面板（文字稿在里面）排在它前面；推荐视频挪到哪里卡片跟到哪里
// ============================================================

const PANEL_TAG = "YTD-ENGAGEMENT-PANEL-SECTION-LIST-RENDERER";
const PANEL_SELECTOR = "ytd-engagement-panel-section-list-renderer";

/** 卡片位置要看的一小棵树：只认侧栏面板这一个选择器。 */
interface Box {
  readonly tagName: string;
  readonly children: Box[];
  parentElement: Box | null;
  firstChild: Box | null;
  nextSibling: Box | null;
  matches(selector: string): boolean;
  querySelector(selector: string): Box | null;
  closest(selector: string): Box | null;
}

function box(tagName = "DIV", children: Box[] = []): Box {
  const self: Box = {
    tagName,
    children,
    parentElement: null,
    firstChild: children[0] ?? null,
    nextSibling: null,
    matches: (selector) => selector === PANEL_SELECTOR && self.tagName === PANEL_TAG,
    querySelector(selector) {
      for (const child of self.children) {
        const found = child.matches(selector) ? child : child.querySelector(selector);
        if (found) return found;
      }
      return null;
    },
    closest(selector) {
      for (let at: Box | null = self; at; at = at.parentElement) if (at.matches(selector)) return at;
      return null;
    },
  };
  children.forEach((child, index) => {
    child.parentElement = self;
    child.nextSibling = children[index + 1] ?? null;
  });
  return self;
}

function assertSlot(slot: { parent: Element; before: Node | null } | null | undefined, parent: Box, before: Box | null): void {
  assert.ok(slot);
  assert.equal(slot.parent as unknown, parent);
  assert.equal(slot.before as unknown, before);
}

const RELATED = "ytd-watch-flexy #related";
const SECONDARY_INNER = "ytd-watch-flexy #secondary-inner";
const SECONDARY = "ytd-watch-flexy #secondary";

test("卡片排在右栏推荐视频的上面，装着文字稿面板的那一层在它前面；不在观看页时没有位置", () => {
  const panels = box("DIV", [box(PANEL_TAG), box(PANEL_TAG)]);
  const related = box();
  const column = box("DIV", [panels, related]);
  const watching = pageAt(watch(ID));
  watching.document.matches.set(RELATED, related as unknown as FakeElement);
  assertSlot(watching.page.cardSlot?.(), column, related);

  const home = pageAt("https://www.youtube.com/");
  home.document.matches.set(RELATED, related as unknown as FakeElement);
  assert.equal(home.page.cardSlot?.(), null, "首页上外壳还在，只是藏着");
});

test("剧场模式、窄窗口时推荐视频挪到播放器下面：卡片跟着它走", () => {
  const { page, document } = pageAt(watch(ID));
  const related = box();
  const column = box("DIV", [box(), related]);
  document.matches.set(RELATED, related as unknown as FakeElement);
  assertSlot(page.cardSlot?.(), column, related);

  const moved = box();
  const under = box("DIV", [box(), moved]);
  document.matches.set(RELATED, moved as unknown as FakeElement);
  assertSlot(page.cardSlot?.(), under, moved);
});

test("推荐视频还没出来：排在右栏里最后一个侧栏面板后面，没有面板时在最上面；右栏也没有时是 null，卡片悬浮", () => {
  const { page, document } = pageAt(watch(ID));
  assert.equal(page.cardSlot?.(), null);

  const first = box();
  const plain = box("DIV", [first]);
  document.matches.set(SECONDARY, plain as unknown as FakeElement);
  assertSlot(page.cardSlot?.(), plain, first);

  const chat = box();
  const inner = box("DIV", [box("DIV", [box(PANEL_TAG)]), box(PANEL_TAG), chat]);
  document.matches.set(SECONDARY_INNER, inner as unknown as FakeElement);
  assertSlot(page.cardSlot?.(), inner, chat);

  const onlyPanels = box("DIV", [box(PANEL_TAG)]);
  document.matches.set(SECONDARY_INNER, onlyPanels as unknown as FakeElement);
  assertSlot(page.cardSlot?.(), onlyPanels, null);
});

test("找到的位置在侧栏面板里面时不插：卡片不挤进文字稿面板，也不会被当成面板内容读到", () => {
  const { page, document } = pageAt(watch(ID));
  const related = box();
  box(PANEL_TAG, [box("DIV", [related])]);
  document.matches.set(RELATED, related as unknown as FakeElement);
  const inner = box("DIV", [box(PANEL_TAG)]);
  document.matches.set(SECONDARY_INNER, inner as unknown as FakeElement);
  assertSlot(page.cardSlot?.(), inner, null);

  const nested = box();
  box(PANEL_TAG, [nested]);
  document.matches.set(SECONDARY_INNER, nested as unknown as FakeElement);
  assert.equal(page.cardSlot?.(), null);
});
