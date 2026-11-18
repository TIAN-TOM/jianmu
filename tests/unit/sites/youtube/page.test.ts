// YouTube 观看页：页面用结构替身代替，这里只看地址比对、站内跳转、广告、挂载点、控制栏和频道，渲染留给无头 Chrome。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createYoutubePage } from "../../../../src/sites/youtube/page.ts";

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
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
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
  await new Promise((resolve) => setImmediate(resolve));
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
