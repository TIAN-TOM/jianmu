// 替用户点开文字稿面板：页面用结构替身代替。看能点的只有入口按钮和文字稿页签、一次只点一下、点了等结果，
// 以及本来就开着、搜索框里有字、正在播广告、视频对不上、页面上没有入口时都不点。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import { createPanelOpener } from "../../../../src/sites/youtube/page/commands.ts";

const ID = "jmSample0001";
const OTHER = "jmSample0002";
const PANELS = "ytd-engagement-panel-section-list-renderer";
const SEGMENTS = "ytd-transcript-segment-renderer, transcript-segment-view-model";
const ENTRY = "ytd-video-description-transcript-section-renderer";

class FakeNode {
  readonly attributes = new Map<string, string>();
  readonly found = new Map<string, FakeNode>();
  readonly lists = new Map<string, FakeNode[]>();
  readonly classes = new Set<string>();
  readonly classList = { contains: (name: string) => this.classes.has(name) };
  parent: FakeNode | null = null;
  tag = "";
  value = "";
  clicks = 0;
  onClick: (() => void) | null = null;
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  querySelector(selector: string): FakeNode | null {
    for (const part of [selector, ...selector.split(/\s*,\s*/)]) {
      const hit = this.found.get(part) ?? this.lists.get(part)?.[0];
      if (hit) return hit;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeNode[] {
    return this.lists.get(selector) ?? selector.split(/\s*,\s*/).flatMap((part) => this.lists.get(part) ?? []);
  }
  closest(selector: string): FakeNode | null {
    for (let node = this.parent; node; node = node.parent) if (node.tag === selector) return node;
    return null;
  }
  click(): void {
    this.clicks += 1;
    this.onClick?.();
  }
}

function world() {
  const document = new FakeNode();
  const location = { href: `https://www.youtube.com/watch?v=${ID}` };
  const shell = new FakeNode();
  shell.attributes.set("video-id", ID);
  document.found.set("ytd-watch-flexy", shell);
  const player = new FakeNode();
  document.found.set("ytd-watch-flexy .html5-video-player", player);
  document.lists.set(PANELS, []);
  let clock = 0;
  const opener = createPanelOpener({
    document: document as unknown as Document,
    currentRef: (): VideoRef | null => ({ platform: "youtube", videoId: new URL(location.href).searchParams.get("v") ?? "" }),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  const addPanel = (targetId: string | null): FakeNode => {
    const panel = new FakeNode();
    panel.tag = PANELS;
    panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    if (targetId) panel.attributes.set("target-id", targetId);
    document.lists.set(PANELS, [...(document.lists.get(PANELS) ?? []), panel]);
    return panel;
  };
  /** 一个文字稿入口和它的按钮；inPanel 时它在一直关着的面板里。 */
  const addEntry = (inPanel: FakeNode | null = null): FakeNode => {
    const entry = new FakeNode();
    entry.parent = inPanel;
    const button = new FakeNode();
    button.parent = entry;
    entry.found.set("button", button);
    document.lists.set(ENTRY, [...(document.lists.get(ENTRY) ?? []), entry]);
    return button;
  };
  /** 页面展开面板、放进段落。 */
  const show = (panel: FakeNode) => {
    panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    panel.found.set('[data-target-id="PAmodern_transcript_view"]', new FakeNode());
    panel.lists.set(SEGMENTS, [new FakeNode()]);
  };
  const ask = async (videoId = ID) => (await opener.handle({ type: "youtube.openTranscript", req: { videoId } }))?.outcome;
  return { document, location, shell, player, addPanel, addEntry, show, ask, elapsed: () => clock };
}

test("没打开时点简介里的入口一下，等到段落出来；一直关着的面板里那个入口不点", async () => {
  const w = world();
  const shellPanel = w.addPanel("engagement-panel-structured-description");
  const hidden = w.addEntry(shellPanel);
  const visible = w.addEntry();
  const panel = w.addPanel("PAmodern_transcript_view");
  visible.onClick = () => w.show(panel);
  assert.equal(await w.ask(), "opened");
  assert.equal(visible.clicks, 1);
  assert.equal(hidden.clicks, 0);
});

test("点了没开：只点一下，等满了照实报没开，不连点", async () => {
  const w = world();
  const button = w.addEntry();
  assert.equal(await w.ask(), "not-opened");
  assert.equal(button.clicks, 1);
  assert.ok(w.elapsed() >= 6000);
});

test("带页签的面板选着章节：点没选中的文字稿页签，不点入口", async () => {
  const w = world();
  const entry = w.addEntry();
  const panel = w.addPanel(null);
  panel.attributes.set("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
  const chapters = Object.assign(new FakeNode(), {});
  chapters.attributes.set("aria-selected", "true");
  const transcript = new FakeNode();
  transcript.attributes.set("aria-selected", "false");
  panel.lists.set('[role="tab"]', [chapters, transcript]);
  transcript.onClick = () => w.show(panel);
  assert.equal(await w.ask(), "opened");
  assert.equal(transcript.clicks, 1);
  assert.equal(chapters.clicks, 0);
  assert.equal(entry.clicks, 0);
});

test("本来就开着：什么都不点；搜索框里有字：也不点，交给读取去报", async () => {
  const w = world();
  const entry = w.addEntry();
  const panel = w.addPanel("PAmodern_transcript_view");
  w.show(panel);
  assert.equal(await w.ask(), "already-open");
  panel.lists.set("textarea", [Object.assign(new FakeNode(), { value: "关键词" })]);
  assert.equal(await w.ask(), "searching");
  assert.equal(entry.clicks, 0);
});

test("正在播广告、页面上不是这个视频、页面上没有入口：都不点", async () => {
  const ad = world();
  const adButton = ad.addEntry();
  ad.player.classes.add("ad-showing");
  assert.equal(await ad.ask(), "ad");
  assert.equal(adButton.clicks, 0);

  const moved = world();
  const movedButton = moved.addEntry();
  assert.equal(await moved.ask(OTHER), "video-changed");
  moved.shell.attributes.set("video-id", OTHER);
  assert.equal(await moved.ask(), "video-changed", "外壳和地址对不上，换视频的途中");
  assert.equal(movedButton.clicks, 0);

  const bare = world();
  assert.equal(await bare.ask(), "no-entry");
});

test("点了以后等的途中换了视频：报视频已换", async () => {
  const w = world();
  const button = w.addEntry();
  button.onClick = () => {
    w.location.href = `https://www.youtube.com/watch?v=${OTHER}`;
  };
  assert.equal(await w.ask(), "video-changed");
});

test("只认这一种问话", () => {
  const w = world();
  const opener = createPanelOpener({ document: w.document as unknown as Document, currentRef: () => null });
  assert.equal(opener.handle({ type: "youtube.panel", req: { videoId: ID } }), null);
  assert.equal(opener.handle({ type: "youtube.openTranscript", req: {} }), null);
  assert.equal(opener.handle(null), null);
});
