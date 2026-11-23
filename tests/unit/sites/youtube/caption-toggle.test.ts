// 替用户开关播放器的字幕：页面用结构替身代替，小桥接住的字幕由测试给。看小桥里已经有就不点；字幕关着时点一下、等到接住、
// 读完只关这次点开的；开着却没接住、在播广告、视频对不上、按钮不在或标着不可用时都不点；一次只点一下，不连点、不重试。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { PlayerCaption } from "../../../../src/sites/youtube/page/caption-types.ts";
import { CAPTION_WAIT_MS, createCaptionToggle } from "../../../../src/sites/youtube/page/commands.ts";
import type { PlayerTracks } from "../../../../src/sites/youtube/page/panel-types.ts";

const ID = "jmSample0001";
const OTHER = "jmSample0002";
const BUTTON = "ytd-watch-flexy .html5-video-player .ytp-subtitles-button";
const CAPTION: PlayerCaption = { videoId: ID, lang: "en", auto: false, translated: false, targetLang: "", text: '{"events":[]}' };
const TRACKS: PlayerTracks = { videoId: ID, tracks: [], defaultIndex: null, hasDefault: null };

class FakeNode {
  readonly attributes = new Map<string, string>();
  readonly found = new Map<string, FakeNode>();
  readonly classes = new Set<string>();
  readonly classList = { contains: (name: string) => this.classes.has(name) };
  isConnected = true;
  clicks = 0;
  onClick: (() => void) | null = null;
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  querySelector(selector: string): FakeNode | null {
    return this.found.get(selector) ?? null;
  }
  click(): void {
    this.clicks += 1;
    this.onClick?.();
  }
}

function world({ pressed = "false", fetchAfterMs = 400 as number | null } = {}) {
  const document = new FakeNode();
  const shell = new FakeNode();
  shell.attributes.set("video-id", ID);
  document.found.set("ytd-watch-flexy", shell);
  const player = new FakeNode();
  document.found.set("ytd-watch-flexy .html5-video-player", player);
  const button = new FakeNode();
  button.attributes.set("aria-pressed", pressed);
  document.found.set(BUTTON, button);
  let url = ID;
  let clock = 0;
  let caught: PlayerCaption | null = null;
  const scheduled: { at: number; run: () => void }[] = [];
  const after = (ms: number, run: () => void): void => void scheduled.push({ at: clock + ms, run });
  // 播放器：点了按钮就换开关状态，打开时过一会儿自己取回字幕。
  button.onClick = () => {
    const on = button.getAttribute("aria-pressed") !== "true";
    button.attributes.set("aria-pressed", String(on));
    if (on && fetchAfterMs !== null) after(fetchAfterMs, () => (caught = { ...CAPTION, videoId: shell.getAttribute("video-id") ?? "" }));
  };
  const toggle = createCaptionToggle({
    document: document as unknown as Document,
    currentRef: (): VideoRef | null => ({ platform: "youtube", videoId: url }),
    caption: (videoId) => (caught?.videoId === videoId ? caught : null),
    tracks: () => TRACKS,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      for (const due of scheduled.filter((item) => item.at <= clock)) {
        scheduled.splice(scheduled.indexOf(due), 1);
        due.run();
      }
    },
  });
  const ask = async (videoId = ID) => toggle.handle({ type: "youtube.caughtCaptions", req: { videoId } });
  const navigate = (id: string) => {
    url = id;
    shell.attributes.set("video-id", id);
  };
  return { document, player, button, ask, after, navigate, setCaught: (value: PlayerCaption | null) => (caught = value), elapsed: () => clock };
}

test("字幕关着：点一下，等播放器取回来接住，读完点一下关上；交回字幕和字幕轨列表", async () => {
  const w = world();
  assert.deepEqual(await w.ask(), { outcome: "caught", caption: CAPTION, player: TRACKS });
  assert.equal(w.button.clicks, 2);
  assert.equal(w.button.getAttribute("aria-pressed"), "false");
});

test("小桥里已经有这个视频的：不点，直接交", async () => {
  const w = world({ pressed: "true" });
  w.setCaught(CAPTION);
  assert.equal((await w.ask())?.outcome, "caught");
  assert.equal(w.button.clicks, 0);
});

test("字幕本来就开着却没接住：不点，照实报", async () => {
  const w = world({ pressed: "true" });
  assert.deepEqual(await w.ask(), { outcome: "on-missed", caption: null, player: null });
  assert.equal(w.button.clicks, 0);
});

test("点开以后等够了还没接住：只点开一次、关上一次，不重试", async () => {
  const w = world({ fetchAfterMs: null });
  assert.equal((await w.ask())?.outcome, "not-caught");
  assert.equal(w.button.clicks, 2);
  assert.ok(w.elapsed() >= CAPTION_WAIT_MS && w.elapsed() < CAPTION_WAIT_MS + 1000);
  assert.equal(w.button.getAttribute("aria-pressed"), "false");
});

test("在播广告、视频对不上、按钮不在、标着不可用、认不出开没开：都不点", async () => {
  const ad = world();
  ad.player.classes.add("ad-showing");
  assert.equal((await ad.ask())?.outcome, "ad");
  assert.equal((await world().ask(OTHER))?.outcome, "video-changed");
  for (const change of [
    (w: ReturnType<typeof world>) => w.document.found.delete(BUTTON),
    (w: ReturnType<typeof world>) => w.button.attributes.set("aria-disabled", "true"),
    (w: ReturnType<typeof world>) => w.button.attributes.set("disabled", ""),
    (w: ReturnType<typeof world>) => w.button.attributes.delete("aria-pressed"),
  ]) {
    const w = world();
    change(w);
    assert.equal((await w.ask())?.outcome, "no-button");
    assert.equal(w.button.clicks, 0);
  }
});

test("等的时候换了视频：报视频已换，不替新视频关字幕；用户自己关上的不再点", async () => {
  const moved = world({ fetchAfterMs: null });
  moved.after(400, () => moved.navigate(OTHER));
  assert.equal((await moved.ask())?.outcome, "video-changed");
  assert.equal(moved.button.clicks, 1);

  const closed = world({ fetchAfterMs: 1000 });
  closed.after(400, () => closed.button.attributes.set("aria-pressed", "false"));
  assert.equal((await closed.ask())?.outcome, "caught");
  assert.equal(closed.button.clicks, 1);
});

test("认不出的请求不管", () => {
  const w = world();
  assert.equal(createCaptionToggle({ document: w.document as unknown as Document, currentRef: () => null }).handle({ type: "youtube.openTranscript", req: { videoId: ID } }), null);
  assert.equal(createCaptionToggle({ document: w.document as unknown as Document, currentRef: () => null }).handle({ type: "youtube.caughtCaptions", req: {} }), null);
});
