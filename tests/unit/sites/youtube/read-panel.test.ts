// 读文字稿面板：页面用结构替身代替。看面板几种状态、内容归属（换视频后没更新的不认、接上之前就开着的不认）、
// 时间超出视频时长的不认、新旧两种段落写法，以及只回认得的问话。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { PanelSnapshot } from "../../../../src/sites/youtube/page/panel-types.ts";
import { createPanelReader, parseTimestamp } from "../../../../src/sites/youtube/page/read-panel.ts";

const ID = "jmSample0001";
const OTHER = "jmSample0002";
const PANEL = 'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]';
const SEGMENTS = "ytd-transcript-segment-renderer, transcript-segment-view-model";

class FakeNode {
  textContent: string;
  readonly attributes = new Map<string, string>();
  readonly found = new Map<string, FakeNode>();
  readonly lists = new Map<string, FakeNode[]>();
  duration = Number.NaN;
  constructor(text = "") {
    this.textContent = text;
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string): FakeNode | null {
    return this.found.get(selector) ?? null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.lists.get(selector) ?? [];
  }
}

/** 旧式段落：时间和文字各有类名。 */
function classic(time: string, text: string): FakeNode {
  const segment = new FakeNode(`${time} ${text}`);
  segment.found.set(".segment-timestamp", new FakeNode(time));
  segment.found.set(".segment-text", new FakeNode(text));
  return segment;
}

function world(href = `https://www.youtube.com/watch?v=${ID}`) {
  const document = new FakeNode();
  const location = { href };
  const shell = new FakeNode();
  shell.attributes.set("video-id", ID);
  document.found.set("ytd-watch-flexy", shell);
  document.found.set("ytd-watch-metadata", new FakeNode());
  document.found.set("ytd-watch-metadata h1", new FakeNode(" 自造的标题 "));
  document.found.set("ytd-watch-metadata ytd-channel-name a", new FakeNode("自造频道"));
  document.found.set("ytd-watch-metadata #description-inline-expander", new FakeNode("自造的简介"));
  const video = new FakeNode();
  video.duration = 120;
  document.found.set("ytd-watch-flexy .html5-video-player video.html5-main-video", video);
  let clock = 0;
  const observers = new Map<FakeNode, () => void>();
  const ticks = new Set<() => void>();
  const makeReader = () =>
    createPanelReader({
      document: document as unknown as Document,
      currentRef: (): VideoRef | null => {
        const id = new URL(location.href).searchParams.get("v");
        return id ? { platform: "youtube", videoId: id } : null;
      },
      channelId: () => "UCsample0000000000000001",
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      every: (_ms, run) => {
        ticks.add(run);
        return () => void ticks.delete(run);
      },
      observe: (target, run) => {
        observers.set(target as unknown as FakeNode, run);
        return () => void observers.delete(target as unknown as FakeNode);
      },
    });
  /** 页面上出现一个面板（还没展开、没有段落）。 */
  const addPanel = (): FakeNode => {
    const panel = new FakeNode();
    panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    document.found.set(PANEL, panel);
    return panel;
  };
  /** 用户打开面板、页面填好段落：面板内容变了一次。 */
  const fill = (panel: FakeNode, segments: FakeNode[], label = "English (auto-generated)") => {
    panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    panel.lists.set(SEGMENTS, segments);
    document.found.set("ytd-transcript-footer-renderer yt-dropdown-menu #label-text", new FakeNode(label));
    observers.get(panel)?.();
    clock += 1000;
  };
  /** 用户把面板关上：页面只改可见性，段落留着。 */
  const close = (panel: FakeNode) => {
    panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    observers.get(panel)?.();
    clock += 1000;
  };
  const go = (id: string) => {
    location.href = `https://www.youtube.com/watch?v=${id}`;
    shell.attributes.set("video-id", id);
  };
  const ask = async (reader: ReturnType<typeof makeReader>, videoId = ID) => (await reader.handle({ type: "youtube.panel", req: { videoId } })) as PanelSnapshot;
  /** 面板有了变化：页面上的观察者回调。 */
  const notify = (panel: FakeNode) => {
    observers.get(panel)?.();
    clock += 1000;
  };
  return { document, shell, video, makeReader, addPanel, fill, close, go, ask, notify, tick: () => ticks.forEach((run) => run()), wait: (ms: number) => void (clock += ms) };
}

test("时间写法：分秒、时分秒都认，秒和分超过 59 的、别的写法不认", () => {
  assert.equal(parseTimestamp("0:05"), 5);
  assert.equal(parseTimestamp("12:34"), 754);
  assert.equal(parseTimestamp("1:02:03"), 3723);
  for (const text of ["", "5", "1:5", "1:60", "1:61:00", "a:bc", "1:02:03:04"]) assert.equal(parseTimestamp(text), null, text);
});

test("面板在页面上、用户打开以后读到：段落、语言菜单的名字、标题作者简介和时长，时间往后走", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "第一句"), classic("0:04", " 第二句  "), classic("1:00", "第三句")]);
  const snapshot = await w.ask(reader);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.videoId, ID);
  assert.equal(snapshot.label, "English (auto-generated)");
  assert.deepEqual(snapshot.cues, [
    { start: 0, text: "第一句" },
    { start: 4, text: "第二句" },
    { start: 60, text: "第三句" },
  ]);
  assert.deepEqual(snapshot.info, { title: "自造的标题", author: "自造频道", channelId: "UCsample0000000000000001", description: "自造的简介", durationSec: 120 });
});

test("新式段落没有类名：时间是开头那一截，剩下的是文字；时间认不出的段落不要", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [new FakeNode("0:01 新式的第一句"), new FakeNode("没有时间的一段"), new FakeNode("1:02 新式的第二句")]);
  assert.deepEqual((await w.ask(reader)).cues, [
    { start: 1, text: "新式的第一句" },
    { start: 62, text: "新式的第二句" },
  ]);
});

test("面板没展开报 closed，页面上连入口都没有报 no-entry", async () => {
  const w = world();
  const reader = w.makeReader();
  assert.equal((await w.ask(reader)).state, "no-entry");
  w.document.found.set("ytd-video-description-transcript-section-renderer", new FakeNode());
  assert.equal((await w.ask(reader)).state, "closed");
  w.addPanel();
  w.tick();
  assert.equal((await w.ask(reader)).state, "closed");
});

test("简幕接上之前面板就开着、填好了：认不出是谁的，要用户关上再开", async () => {
  const w = world();
  const panel = w.addPanel();
  panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
  panel.lists.set(SEGMENTS, [classic("0:00", "早就在的一句")]);
  const reader = w.makeReader();
  const before = await w.ask(reader);
  assert.equal(before.state, "reopen");
  assert.deepEqual(before.cues, []);
  // 用户关上再开，页面重新填了一遍。
  w.close(panel);
  w.fill(panel, [classic("0:00", "重开以后的一句")]);
  assert.equal((await w.ask(reader)).state, "ready");
});

test("换了视频而面板没更新：报 stale；面板一直开着时直接换掉的内容也不认；用户关上再打开、页面换成新内容以后才认", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "上一个视频的一句")]);
  w.go(OTHER);
  const stale = await w.ask(reader, OTHER);
  assert.equal(stale.state, "stale");
  assert.equal(stale.videoId, OTHER);
  assert.deepEqual(stale.cues, []);
  // 用户在旧面板里换了语言：段落变了，可面板一直开着，还是上一个视频的面板。
  w.fill(panel, [classic("0:00", "上一个视频换了语言的一句")], "Deutsch");
  assert.equal((await w.ask(reader, OTHER)).state, "stale");
  // 关上再打开，页面为新视频重新取来了段落。
  w.close(panel);
  w.fill(panel, [classic("0:00", "新视频的一句")]);
  const fresh = await w.ask(reader, OTHER);
  assert.equal(fresh.state, "ready");
  assert.deepEqual(fresh.cues, [{ start: 0, text: "新视频的一句" }]);
});

test("换了视频以后面板里只有语言菜单这类别的东西变了：段落没变，照样不认", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "上一个视频的一句")]);
  w.go(OTHER);
  // 页面改了语言菜单的名字，面板有变化，段落还是上一个视频的。
  w.document.found.set("ytd-transcript-footer-renderer yt-dropdown-menu #label-text", new FakeNode("English"));
  w.fill(panel, [classic("0:00", "上一个视频的一句")], "English");
  assert.equal((await w.ask(reader, OTHER)).state, "stale");
});

test("播广告时不拿视频元素的时长：那是广告的", async () => {
  const w = world();
  const panel = w.addPanel();
  const player = new FakeNode();
  Object.assign(player, { classList: { contains: (name: string) => name === "ad-showing" } });
  w.document.found.set("ytd-watch-flexy .html5-video-player", player);
  w.video.duration = 15;
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "一句"), classic("1:00", "一分钟以后的一句")]);
  const snapshot = await w.ask(reader);
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.info.durationSec, 0);
});

test("同一个视频里在面板换语言：照样认；搜索框里有字：只显示了一部分，不交", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "一句")]);
  w.fill(panel, [classic("0:00", "eine Zeile")], "Deutsch");
  const switched = await w.ask(reader);
  assert.equal(switched.state, "ready");
  assert.equal(switched.label, "Deutsch");
  const input = Object.assign(new FakeNode(), { value: "关键词" });
  panel.lists.set("input", [input]);
  assert.equal((await w.ask(reader)).state, "filtered");
});

test("关上再打开以后过了好一阵才换掉内容：不当成页面重新取来的", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "上一个视频的一句")]);
  w.go(OTHER);
  w.close(panel);
  panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
  await w.ask(reader, OTHER);
  w.wait(60_000);
  w.fill(panel, [classic("0:00", "过了好久才换的一句")], "Deutsch");
  assert.equal((await w.ask(reader, OTHER)).state, "stale");
});

/** 在面板上方的搜索框里打字或清空：页面按搜索词重排段落，面板有变化。 */
function search(w: ReturnType<typeof world>, panel: FakeNode, text: string, segments: FakeNode[]) {
  const input = Object.assign(new FakeNode(), { value: text });
  panel.lists.set("input", [input]);
  panel.lists.set(SEGMENTS, segments);
  w.notify(panel);
}

test("换视频以后在旧面板里搜索，把段落滤空再清掉搜索词：回来的还是上一个视频的，不认", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  const old = [classic("0:00", "上一个视频的一句"), classic("0:05", "上一个视频的第二句")];
  w.fill(panel, old);
  w.go(OTHER);
  search(w, panel, "没有的词", []);
  assert.equal((await w.ask(reader, OTHER)).state, "filtered");
  search(w, panel, "", old);
  const snapshot = await w.ask(reader, OTHER);
  assert.equal(snapshot.state, "stale");
  assert.deepEqual(snapshot.cues, []);
});

test("关上再打开以后马上搜索滤空、再清掉：也不当成页面为新视频取来的", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  const old = [classic("0:00", "上一个视频的一句")];
  w.fill(panel, old);
  w.go(OTHER);
  w.close(panel);
  panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
  w.notify(panel);
  search(w, panel, "没有的词", []);
  search(w, panel, "", old);
  assert.equal((await w.ask(reader, OTHER)).state, "stale");
});

test("同一个视频里搜索滤空再清掉：照样认", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  const lines = [classic("0:00", "一句"), classic("0:05", "第二句")];
  w.fill(panel, lines);
  search(w, panel, "没有的词", []);
  search(w, panel, "", lines);
  assert.equal((await w.ask(reader)).state, "ready");
});

test("中间某一段的文字变了：段数、语言名、首尾几段都没变，也算内容变了", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  const lines = Array.from({ length: 8 }, (_, index) => classic(`0:0${index}`, `第 ${index} 句`));
  w.fill(panel, lines);
  const current = async () => ((await reader.handle({ type: "youtube.current", req: { videoId: ID } })) as { stamp: number }).stamp;
  const before = await current();
  lines[3] = classic("0:03", "改过的第 3 句");
  panel.lists.set(SEGMENTS, [...lines]);
  w.notify(panel);
  assert.ok((await current()) > before);
});

test("观看页的标题区还没出来：按加载中，不说没有入口", async () => {
  const w = world();
  w.document.found.delete("ytd-watch-metadata");
  const reader = w.makeReader();
  assert.equal((await w.ask(reader)).state, "loading");
});

test("换视频的途中地址和外壳对不上：认不出是哪个视频，问哪个都不交内容", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "一句")]);
  w.shell.attributes.set("video-id", OTHER);
  const snapshot = await w.ask(reader);
  assert.equal(snapshot.videoId, "");
  assert.notEqual(snapshot.state, "ready");
  assert.deepEqual(snapshot.cues, []);
});

test("问的视频不是页面上的视频、或者最后一句比视频时长晚得多：不交内容", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "一句")]);
  const asked = await w.ask(reader, OTHER);
  assert.equal(asked.videoId, ID);
  assert.deepEqual(asked.cues, []);
  w.fill(panel, [classic("0:00", "一句"), classic("10:00", "远超时长的一句")]);
  assert.equal((await w.ask(reader)).state, "stale");
});

test("只回认得的两种问话；current 只回视频和内容换过几次", async () => {
  const w = world();
  const reader = w.makeReader();
  assert.equal(reader.handle({ type: "player.seek", req: { videoId: ID } }), null);
  assert.equal(reader.handle({ type: "youtube.panel", req: {} }), null);
  assert.equal(reader.handle(null), null);
  const before = (await reader.handle({ type: "youtube.current", req: { videoId: ID } })) as { videoId: string; stamp: number };
  const panel = w.addPanel();
  w.tick();
  w.fill(panel, [classic("0:00", "一句")]);
  const after = (await reader.handle({ type: "youtube.current", req: { videoId: ID } })) as { videoId: string; stamp: number };
  assert.equal(after.videoId, ID);
  assert.ok(after.stamp > before.stamp);
  reader.stop();
});
