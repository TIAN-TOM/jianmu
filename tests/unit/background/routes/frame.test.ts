// 解释当前画面的路由，走真的后台：播放页图标收两站的内容脚本，视频以发送方标签页地址上的为准，分发时先打开侧边栏；
// 侧边栏点的要带标签页；两条共用每标签页每分钟 6 次。结果按标签页记在后台，侧边栏来取。设置页能探一次能不能看图。
import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_LIMIT } from "../../../../src/background/services/frame-explain.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import type { FrameEntryView, FrameHereView, FrameRecentView, ImageProbeView } from "../../../../src/shared/messages/frame.ts";
import { senders, TUBE_ORIGIN, tubeUrl, watchUrl } from "../../../helpers/chrome.ts";
import { chatReply, reply, type SentRequest } from "../../../helpers/fake-model-service.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";
import { until } from "../../../helpers/wait-until.ts";

const PLAYING: VideoKey = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });
const TAB = 31;
const JPEG = `data:image/jpeg;base64,${"A".repeat(200)}`;
const FORBIDDEN = { ok: false, code: "FORBIDDEN" };

const capture = (_tabId: number, message: unknown) => {
  const req = (message as { readonly req?: { readonly video?: string } }).req;
  return { ok: true, value: { dataUrl: JPEG, width: 640, height: 360, atSec: 12.3, video: req?.video } };
};

const hasImage = (request: SentRequest): boolean => JSON.stringify(request.body?.messages ?? []).includes("image_url");

// 探测图问的是颜色，答红色；别的请求回一段解释。
const answering = (request: SentRequest) =>
  chatReply(JSON.stringify(request.body?.messages ?? []).includes("这张小图是什么颜色") ? "红色" : "画面上是一张受力分析图。");

function background(
  handler: (request: SentRequest) => ReturnType<typeof chatReply> = answering,
  options: { readonly panelOpenRefused?: boolean; readonly grantedOrigins?: readonly string[]; readonly tabTitles?: Readonly<Record<number, string>> } = {},
) {
  return studyBackground({ handler, tabReply: capture, ...options });
}

async function recent(bg: ReturnType<typeof background>, tabId = TAB): Promise<readonly FrameEntryView[]> {
  const listed = await bg.send<FrameRecentView>("frame.recent", { tabId });
  assert.ok(listed.ok, JSON.stringify(listed));
  return listed.value.entries;
}

async function finished(bg: ReturnType<typeof background>, tabId = TAB): Promise<FrameEntryView> {
  let entry: FrameEntryView | undefined;
  await until(async () => {
    entry = (await recent(bg, tabId))[0];
    return entry !== undefined && entry.state !== "running";
  });
  assert.ok(entry);
  return entry;
}

test("播放页图标：先打开侧边栏，向发送方标签页要一帧，带图发给模型，结果在侧边栏按标签页取", async () => {
  const bg = background();
  const here = await bg.send<FrameHereView>("frame.explainHere", { video: PLAYING }, senders.content(watchUrl(SAMPLE_ID), TAB));
  assert.deepEqual(here, { ok: true, value: { opened: true } });
  assert.deepEqual(bg.fake.calls.panelOpens, [3], "打开的是发送方所在窗口的侧边栏");

  const entry = await finished(bg);
  assert.deepEqual([entry.state, entry.explanation, entry.atSec], ["done", "画面上是一张受力分析图。", 12.3], JSON.stringify(entry.error));
  const asked = bg.fake.calls.tabMessages.filter(({ message }) => (message as { type?: string }).type === "player.captureFrame");
  assert.deepEqual(asked, [{ tabId: TAB, message: { type: "player.captureFrame", req: { video: PLAYING, maxEdge: 1456 } } }]);
  const posts = bg.ai.posts();
  assert.ok(posts.some(hasImage), "带着图");
  assert.ok(bg.fake.calls.broadcasts.some((message) => (message as { type?: string }).type === "panel.follow"), "侧边栏跟到这个标签页");
});

test("播放页图标：消息里的视频和标签页地址上的对不上就拒，不截、不打开侧边栏之外的事", async () => {
  const bg = background();
  const other = videoKey({ platform: "bilibili", videoId: "BV1Sample002", segment: 1 });
  assert.deepEqual(await bg.send("frame.explainHere", { video: other }, senders.content(watchUrl(SAMPLE_ID), TAB)), FORBIDDEN);
  assert.deepEqual(await bg.send("frame.explainHere", { video: PLAYING, extra: 1 }, senders.content(watchUrl(SAMPLE_ID), TAB)), { ok: false, code: "INVALID_REQUEST" });
  assert.deepEqual(await bg.send("frame.explainHere", { video: PLAYING }, senders.panel()), FORBIDDEN, "侧边栏不能走这条");
  assert.deepEqual(await recent(bg), []);
  assert.equal(bg.ai.posts().length, 0);
});

const TUBE: VideoKey = videoKey({ platform: "youtube", videoId: "tube-sample" });
const TUBE_GRANT = [`${TUBE_ORIGIN}/*`];

test("YouTube 的播放页图标同样收：先打开侧边栏，不向平台核对、不读字幕，只发画面，标题用标签页的", async () => {
  const bg = background(undefined, { grantedOrigins: TUBE_GRANT, tabTitles: { [TAB]: "样例观看页的标题" } });
  const here = await bg.send<FrameHereView>("frame.explainHere", { video: TUBE }, senders.content(tubeUrl(), TAB));
  assert.deepEqual(here, { ok: true, value: { opened: true } });
  assert.deepEqual(bg.fake.calls.panelOpens, [3]);

  const entry = await finished(bg);
  assert.deepEqual([entry.state, entry.video], ["done", TUBE], JSON.stringify(entry.error));
  const asked = bg.fake.calls.tabMessages.map(({ message }) => message);
  assert.deepEqual(asked, [{ type: "player.captureFrame", req: { video: TUBE, maxEdge: 1456 } }], "只向页面要了一帧，没问文字稿面板");
  assert.deepEqual(bg.site.calls, [], "没向平台读");
  const sent = bg.ai.posts().find((request) => hasImage(request) && JSON.stringify(request.body?.messages ?? []).includes("这一帧的时间"));
  assert.ok(sent, "带着图");
  const text = JSON.stringify(sent.body?.messages ?? []);
  assert.ok(text.includes("视频：样例观看页的标题") && text.includes("这一刻前后的字幕：\\n无"), text);

  // 地址上的视频和消息里的对不上就拒。
  const other = videoKey({ platform: "youtube", videoId: "tube-other" });
  assert.deepEqual(await bg.send("frame.explainHere", { video: other }, senders.content(tubeUrl(), TAB)), FORBIDDEN);
});

test("没授权 YouTube 时，残留的内容脚本点图标不收，不截、不发", async () => {
  const bg = background();
  assert.deepEqual(await bg.send("frame.explainHere", { video: TUBE }, senders.content(tubeUrl(), TAB)), { ok: false, code: "NOT_ENABLED" });
  assert.deepEqual(await recent(bg), []);
  assert.equal(bg.fake.calls.tabMessages.filter(({ message }) => (message as { type?: string }).type === "player.captureFrame").length, 0);
  assert.equal(bg.ai.posts().length, 0);
});

test("侧边栏打不开时回 opened: false，解释照样做，结果留在后台等侧边栏来取", async () => {
  const bg = background(undefined, { panelOpenRefused: true });
  assert.deepEqual(await bg.send("frame.explainHere", { video: PLAYING }, senders.content(watchUrl(SAMPLE_ID), TAB)), { ok: true, value: { opened: false } });
  assert.equal((await finished(bg)).state, "done");
});

test("侧边栏入口：带视频和标签页；同一标签页每分钟 6 次，两个入口共用额度", async () => {
  const bg = background();
  assert.deepEqual(await bg.send("frame.explain", { video: PLAYING }), { ok: false, code: "INVALID_REQUEST" });
  assert.deepEqual(await bg.send("frame.explain", { video: PLAYING, tabId: TAB }, senders.options()), FORBIDDEN);
  const started = await bg.send<FrameEntryView>("frame.explain", { video: PLAYING, tabId: TAB });
  assert.ok(started.ok && started.value.state === "running" && started.value.tabId === TAB);
  for (let index = 1; index < FRAME_LIMIT - 1; index += 1) assert.equal((await bg.send("frame.explain", { video: PLAYING, tabId: TAB })).ok, true);
  assert.equal((await bg.send("frame.explainHere", { video: PLAYING }, senders.content(watchUrl(SAMPLE_ID), TAB))).ok, true);
  assert.deepEqual(await bg.send("frame.explain", { video: PLAYING, tabId: TAB }), { ok: false, code: "FRAME_RATE_LIMITED" });
  assert.deepEqual(await bg.send("frame.explainHere", { video: PLAYING }, senders.content(watchUrl(SAMPLE_ID), TAB)), { ok: false, code: "FRAME_RATE_LIMITED" });
});

test("设置页探一次能不能看图：服务以看不了图拒掉就回 false，之后解释画面不截、不发", async () => {
  let sent = 0;
  const bg = background(() => {
    sent += 1;
    return reply({ error: { message: "This model does not support image input." } }, 400);
  });
  assert.deepEqual(await bg.send<ImageProbeView>("ai.probeImage", {}, senders.options()), { ok: true, value: { model: "test-model", imageInput: false } });
  assert.deepEqual(await bg.send("ai.probeImage", {}, senders.panel()), FORBIDDEN);
  const before = sent;
  await bg.send("frame.explain", { video: PLAYING, tabId: TAB });
  const entry = await finished(bg);
  assert.equal(entry.error?.code, "AI_IMAGE_UNSUPPORTED");
  assert.equal(sent, before, "记住了不能看，不再发");
  assert.equal(bg.fake.calls.tabMessages.filter(({ message }) => (message as { type?: string }).type === "player.captureFrame").length, 0, "没截");
});
