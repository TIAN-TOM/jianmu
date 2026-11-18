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
  const go = (id: string) => {
    location.href = `https://www.youtube.com/watch?v=${id}`;
    shell.attributes.set("video-id", id);
  };
  const ask = async (reader: ReturnType<typeof makeReader>, videoId = ID) => (await reader.handle({ type: "youtube.panel", req: { videoId } })) as PanelSnapshot;
  return { document, shell, video, makeReader, addPanel, fill, go, ask, tick: () => ticks.forEach((run) => run()) };
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
  w.fill(panel, [classic("0:00", "重开以后的一句")]);
  assert.equal((await w.ask(reader)).state, "ready");
});

test("换了视频而面板没更新：报 stale，不交内容；面板换成新视频的内容以后才认", async () => {
  const w = world();
  const panel = w.addPanel();
  const reader = w.makeReader();
  w.fill(panel, [classic("0:00", "上一个视频的一句")]);
  w.go(OTHER);
  const stale = await w.ask(reader, OTHER);
  assert.equal(stale.state, "stale");
  assert.equal(stale.videoId, OTHER);
  assert.deepEqual(stale.cues, []);
  w.fill(panel, [classic("0:00", "新视频的一句")]);
  const fresh = await w.ask(reader, OTHER);
  assert.equal(fresh.state, "ready");
  assert.deepEqual(fresh.cues, [{ start: 0, text: "新视频的一句" }]);
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
