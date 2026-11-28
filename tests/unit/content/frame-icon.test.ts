// 播放页「解释当前画面」的图标：页面上看得出的拒绝就地提示、不发；能截就交给后台，按侧边栏开没开提示去哪儿看；
// 后台拒了说一句短的、悬停写完整原因；在途时连点不重发；扩展断了联系交给界面收场。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFramePress, frameIconEntries } from "../../../src/content/frame-icon.ts";
import type { FrameTool } from "../../../src/content/frame.ts";
import type { HoverIcons } from "../../../src/content/hover-icons.ts";
import { fail, ok, type Result } from "../../../src/core/errors.ts";
import type { FrameHereView } from "../../../src/shared/messages/frame.ts";
import type { MainVideo } from "../../../src/sites/page-types.ts";
import { SAMPLE_VIDEO_KEY as VIDEO } from "../../helpers/sample-videos.ts";


function setup(options: { readonly main?: MainVideo; readonly confirmed?: boolean; readonly key?: typeof VIDEO | null; readonly reply?: Result<FrameHereView> } = {}) {
  const flashes: string[] = [];
  const titles: string[] = [];
  const sent: string[] = [];
  let gone = false;
  let goneCalls = 0;
  let release: (() => void) | null = null;
  const icons = {
    icon: () => ({ flash: (text: string) => void flashes.push(text), setTitle: (text: string) => void titles.push(text) }),
  } as unknown as HoverIcons;
  const press = createFramePress({
    icons,
    runtime: {
      send: (async (type: string, req: { readonly video: string }) => {
        assert.equal(type, "frame.explainHere");
        sent.push(req.video);
        await new Promise<void>((resolve) => (release = resolve));
        return options.reply ?? ok({ opened: true });
      }) as never,
    },
    currentKey: () => (options.key === undefined ? VIDEO : options.key),
    findMainVideo: () => options.main ?? ({ status: "found", video: {} as HTMLVideoElement } as MainVideo),
    confirmed: () => options.confirmed ?? true,
    gone: () => gone,
    onGone: () => void (goneCalls += 1),
    lang: () => "zh",
  });
  const pressAndFinish = async (): Promise<void> => {
    const pending = press();
    release?.();
    await pending;
  };
  return { press, pressAndFinish, flashes, titles, sent, release: () => release?.(), setGone: () => (gone = true), goneCalls: () => goneCalls };
}

test("能截：交给后台，侧边栏开了说结果在侧边栏，没开说点简幕图标", async () => {
  const opened = setup();
  await opened.pressAndFinish();
  assert.deepEqual(opened.sent, [VIDEO]);
  assert.deepEqual(opened.flashes, ["发送中…", "结果在侧边栏"]);

  const closed = setup({ reply: ok({ opened: false }) });
  await closed.pressAndFinish();
  assert.equal(closed.flashes.at(-1), "点简幕图标看结果");
  assert.match(closed.titles.at(-1) ?? "", /工具栏上的简幕图标/);
});

test("页面上看得出的拒绝就地提示，不发", async () => {
  for (const [options, flash] of [
    [{ main: { status: "none" } }, "没找到视频"],
    [{ key: null }, "没找到视频"],
    [{ main: { status: "ad" } }, "正在播广告"],
    [{ confirmed: false }, "视频还在切换"],
  ] as const) {
    const h = setup(options as Parameters<typeof setup>[0]);
    await h.press();
    assert.deepEqual(h.flashes, [flash]);
    assert.deepEqual(h.sent, []);
  }
});

test("后台拒了：限频说点得太多，别的说没发出去，悬停写完整原因", async () => {
  const limited = setup({ reply: fail("FRAME_RATE_LIMITED") });
  await limited.pressAndFinish();
  assert.equal(limited.flashes.at(-1), "点得太多了");
  assert.match(limited.titles.at(-1) ?? "", /一分钟里点得太多了/);

  const forbidden = setup({ reply: fail("FORBIDDEN") });
  await forbidden.pressAndFinish();
  assert.equal(forbidden.flashes.at(-1), "没发出去");
});

test("在途时连点不重发；扩展断了联系交给界面收场", async () => {
  const h = setup();
  const first = h.press();
  await h.press();
  h.release();
  await first;
  assert.equal(h.sent.length, 1);

  h.setGone();
  await h.press();
  assert.equal(h.goneCalls(), 1);
  assert.equal(h.sent.length, 1);
});

test("没有截帧工具时浮层里不排这个图标", () => {
  assert.deepEqual(frameIconEntries(undefined, () => undefined, "zh"), []);
  assert.equal(frameIconEntries({} as FrameTool, () => undefined, "zh").length, 1);
});
