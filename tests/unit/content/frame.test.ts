// 截帧：每种拒绝分开报（视频已换、找不到视频、正在播广告、受保护、画面没加载好、不在前台、画布被污染），
// 播放中等下一帧、等完再核对一遍，按长边缩小，只回 JPEG 的 data URL；指令形状不对的不认。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFrameCapture,
  createFrameTool,
  FRAME_EDGE_MAX,
  FRAME_EDGE_MIN,
  FRAME_JPEG_QUALITY,
  FRAME_MAX_EDGE,
  frameRequestOf,
  JPEG_DATA_URL_PREFIX,
  NEXT_FRAME_TIMEOUT_MS,
  protectionOf,
  scaledSize,
  type FrameEnv,
} from "../../../src/content/frame.ts";
import { videoKey, type VideoKey } from "../../../src/core/video-ref.ts";
import type { MainVideo } from "../../../src/sites/page-types.ts";
import { until } from "../../helpers/wait-until.ts";

const KEY = videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 1 });
const OTHER = videoKey({ platform: "bilibili", videoId: "BV1Sample002", segment: 1 });
const JPEG = `${JPEG_DATA_URL_PREFIX}AAAA`;

interface FakeVideo {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  mediaKeys?: unknown;
}

function fakeVideo(over: Partial<FakeVideo> = {}): FakeVideo {
  return { paused: true, ended: false, currentTime: 42, readyState: 4, videoWidth: 1920, videoHeight: 1080, mediaKeys: null, ...over };
}

function setup(over: Partial<FrameEnv> = {}, video: FakeVideo | null = fakeVideo()) {
  let key: VideoKey | null = KEY;
  let confirmed = true;
  let main: MainVideo = video ? { status: "found", video: video as unknown as HTMLVideoElement } : { status: "none" };
  let foreground = true;
  const encoded: { width: number; height: number; quality: number }[] = [];
  const waits: number[] = [];
  const env: FrameEnv = {
    currentKey: () => key,
    confirmed: () => confirmed,
    findMainVideo: () => main,
    foreground: () => foreground,
    sawEncrypted: () => false,
    async nextFrame(_video, timeoutMs) {
      waits.push(timeoutMs);
      return 42.04;
    },
    async encode(_video, width, height, quality) {
      encoded.push({ width, height, quality });
      return JPEG;
    },
    ...over,
  };
  const capture = createFrameCapture(env);
  return {
    capture: (request = { video: KEY, maxEdge: FRAME_MAX_EDGE }) => capture(request),
    encoded,
    waits,
    set: {
      key: (next: VideoKey | null) => void (key = next),
      confirmed: (next: boolean) => void (confirmed = next),
      main: (next: MainVideo) => void (main = next),
      foreground: (next: boolean) => void (foreground = next),
    },
  };
}

test("暂停着的视频：直接截，按长边 1456 缩小，JPEG 质量 0.85，回画面、尺寸、播放时间和视频身份", async () => {
  const { capture, encoded, waits } = setup();
  assert.deepEqual(await capture(), { ok: true, value: { dataUrl: JPEG, width: 1456, height: 819, atSec: 42, video: KEY } });
  assert.deepEqual(encoded, [{ width: 1456, height: 819, quality: FRAME_JPEG_QUALITY }]);
  assert.deepEqual(waits, [], "暂停着不等下一帧");
  assert.equal(FRAME_MAX_EDGE, 1456);
  assert.equal(FRAME_JPEG_QUALITY, 0.85);
});

test("播放中：等下一帧画好再截，播放时间用那一帧的媒体时间；等不到就按画面没加载好拒绝", async () => {
  const playing = fakeVideo({ paused: false });
  const ok = setup({}, playing);
  const reply = await ok.capture();
  assert.equal(reply.ok && reply.value.atSec, 42.04);
  assert.deepEqual(ok.waits, [NEXT_FRAME_TIMEOUT_MS]);

  const stuck = setup({ nextFrame: async () => null }, fakeVideo({ paused: false }));
  assert.deepEqual(await stuck.capture(), { ok: false, code: "FRAME_NOT_READY" });
  assert.equal(stuck.encoded.length, 0);
});

test("视频对不上：请求里的视频不是地址上的、地址变了播放器还没换上，都按视频已换拒绝，不截", async () => {
  const { capture, encoded, set } = setup();
  assert.deepEqual(await capture({ video: OTHER, maxEdge: FRAME_MAX_EDGE }), { ok: false, code: "VIDEO_CHANGED" });
  set.confirmed(false);
  assert.deepEqual(await capture(), { ok: false, code: "VIDEO_CHANGED" });
  assert.equal(encoded.length, 0);
});

test("找不到视频和正在播广告分开报", async () => {
  const none = setup({}, null);
  assert.deepEqual(await none.capture(), { ok: false, code: "NO_VIDEO" });
  const ad = setup();
  ad.set.main({ status: "ad" });
  assert.deepEqual(await ad.capture(), { ok: false, code: "AD_PLAYING" });
  assert.equal(none.encoded.length + ad.encoded.length, 0);
});

test("加密播放：视频元素挂了钥匙、报过加密媒体的事件、认不出是不是加密，都按受保护拒绝，不去截黑帧", async () => {
  const keyed = setup({}, fakeVideo({ mediaKeys: {} }));
  assert.deepEqual(await keyed.capture(), { ok: false, code: "PROTECTED" });
  const event = setup({ sawEncrypted: () => true });
  assert.deepEqual(await event.capture(), { ok: false, code: "PROTECTED" });
  const unknown = fakeVideo();
  delete unknown.mediaKeys;
  const noApi = setup({}, unknown);
  assert.deepEqual(await noApi.capture(), { ok: false, code: "PROTECTED" });
  assert.equal(keyed.encoded.length + event.encoded.length + noApi.encoded.length, 0);

  assert.equal(protectionOf(fakeVideo() as unknown as HTMLVideoElement), "clear");
  assert.equal(protectionOf(fakeVideo({ mediaKeys: {} }) as unknown as HTMLVideoElement), "protected");
  assert.equal(protectionOf(fakeVideo({ mediaKeys: undefined }) as unknown as HTMLVideoElement), "unknown");
  assert.equal(protectionOf(unknown as unknown as HTMLVideoElement), "unknown");
});

test("画面没加载好：还没有当前帧的数据、还不知道画面尺寸，都不截", async () => {
  for (const video of [fakeVideo({ readyState: 1 }), fakeVideo({ videoWidth: 0 }), fakeVideo({ videoHeight: 0 })]) {
    const { capture, encoded } = setup({}, video);
    assert.deepEqual(await capture(), { ok: false, code: "FRAME_NOT_READY" });
    assert.equal(encoded.length, 0);
  }
});

test("标签页不在前台不截", async () => {
  const { capture, encoded, set } = setup();
  set.foreground(false);
  assert.deepEqual(await capture(), { ok: false, code: "NOT_FOREGROUND" });
  assert.equal(encoded.length, 0);
});

test("画布被污染：编码报安全错按画布被污染拒绝，别的编码错按画面没加载好；编出来不是 JPEG 也不回", async () => {
  const tainted = setup({
    encode: async () => {
      throw Object.assign(new Error("tainted"), { name: "SecurityError" });
    },
  });
  assert.deepEqual(await tainted.capture(), { ok: false, code: "CANVAS_TAINTED" });
  const broken = setup({
    encode: async () => {
      throw new Error("no context");
    },
  });
  assert.deepEqual(await broken.capture(), { ok: false, code: "FRAME_NOT_READY" });
  for (const dataUrl of ["data:image/png;base64,AAAA", JPEG_DATA_URL_PREFIX]) {
    const wrong = setup({ encode: async () => dataUrl });
    assert.deepEqual(await wrong.capture(), { ok: false, code: "FRAME_NOT_READY" }, dataUrl);
  }
});

test("等下一帧的时候情况变了：换视频、换了视频元素、找不到视频、开始播广告、切到后台、加上了钥匙，各按各的拒绝", async () => {
  const cases: [string, (env: ReturnType<typeof setup>, video: FakeVideo) => void, string][] = [
    ["地址换了视频", (env) => env.set.key(OTHER), "VIDEO_CHANGED"],
    ["播放器没换上", (env) => env.set.confirmed(false), "VIDEO_CHANGED"],
    ["换了视频元素", (env) => env.set.main({ status: "found", video: fakeVideo() as unknown as HTMLVideoElement }), "VIDEO_CHANGED"],
    ["视频元素没了", (env) => env.set.main({ status: "none" }), "VIDEO_CHANGED"],
    ["开始播广告", (env) => env.set.main({ status: "ad" }), "AD_PLAYING"],
    ["切到后台", (env) => env.set.foreground(false), "NOT_FOREGROUND"],
    ["加上了钥匙", (_env, video) => void (video.mediaKeys = {}), "PROTECTED"],
  ];
  for (const [label, change, code] of cases) {
    const video = fakeVideo({ paused: false });
    let env: ReturnType<typeof setup> | null = null;
    env = setup(
      {
        async nextFrame() {
          if (env) change(env, video);
          return 42.04;
        },
      },
      video,
    );
    assert.deepEqual(await env.capture(), { ok: false, code }, label);
    assert.equal(env.encoded.length, 0, label);
  }
});

test("编码的时候换了视频：画面不回", async () => {
  let env: ReturnType<typeof setup> | null = null;
  env = setup({
    async encode() {
      env?.set.key(OTHER);
      return JPEG;
    },
  });
  assert.deepEqual(await env.capture(), { ok: false, code: "VIDEO_CHANGED" });
});

test("按长边等比缩小，不放大，宽高至少 1", () => {
  assert.deepEqual(scaledSize(1920, 1080, 1456), { width: 1456, height: 819 });
  assert.deepEqual(scaledSize(1080, 1920, 1456), { width: 819, height: 1456 });
  assert.deepEqual(scaledSize(640, 360, 1456), { width: 640, height: 360 });
  assert.deepEqual(scaledSize(4000, 2, 16), { width: 16, height: 1 });
});

test("指令形状：只认带视频身份、长边是范围内整数的截帧指令", () => {
  const ok = { type: "player.captureFrame", req: { video: KEY, maxEdge: 1456 } };
  assert.deepEqual(frameRequestOf(ok), { video: KEY, maxEdge: 1456 });
  for (const bad of [
    null,
    { type: "player.getState", req: { video: KEY, maxEdge: 1456 } },
    { type: "player.captureFrame" },
    { type: "player.captureFrame", req: { maxEdge: 1456 } },
    { type: "player.captureFrame", req: { video: KEY, maxEdge: 1456.5 } },
    { type: "player.captureFrame", req: { video: KEY, maxEdge: FRAME_EDGE_MIN - 1 } },
    { type: "player.captureFrame", req: { video: KEY, maxEdge: FRAME_EDGE_MAX + 1 } },
    { type: "player.captureFrame", req: { video: KEY, maxEdge: "1456" } },
  ]) {
    assert.equal(frameRequestOf(bad), null, JSON.stringify(bad));
  }
});

test("截帧工具：认不出的消息回 null；图标截的是地址上的视频，地址上没有视频时按视频已换拒绝", async () => {
  let key: VideoKey | null = KEY;
  const video = fakeVideo() as unknown as HTMLVideoElement;
  const stops: string[] = [];
  const tool = createFrameTool(
    {
      currentKey: () => key,
      confirmed: () => true,
      findMainVideo: () => ({ status: "found", video }),
      foreground: () => true,
      sawEncrypted: () => false,
      nextFrame: async () => null,
      encode: async () => JPEG,
    },
    () => stops.push("stop"),
  );
  assert.equal(tool.handle({ type: "player.seek", req: { video: KEY, atSec: 1 } }), null);
  const handled = await tool.handle({ type: "player.captureFrame", req: { video: KEY, maxEdge: 640 } });
  assert.equal(handled?.ok && handled.value.width, 640);
  const own = await tool.capture();
  assert.equal(own.ok && own.value.width, FRAME_MAX_EDGE);
  key = null;
  assert.deepEqual(await tool.capture(), { ok: false, code: "VIDEO_CHANGED" });
  tool.stop();
  assert.deepEqual(stops, ["stop"]);
});

test("截帧工具停下以后：在途的那次等完下一帧不编码、不回画面，之后来的也不截", async () => {
  const video = fakeVideo({ paused: false }) as unknown as HTMLVideoElement;
  const frame: { ready?: (mediaTime: number | null) => void } = {};
  const encoded: number[] = [];
  const tool = createFrameTool({
    currentKey: () => KEY,
    confirmed: () => true,
    findMainVideo: () => ({ status: "found", video }),
    foreground: () => true,
    sawEncrypted: () => false,
    nextFrame: () => new Promise((resolve) => void (frame.ready = resolve)),
    encode: async (_video, width) => (encoded.push(width), JPEG),
  });
  const pending = tool.handle({ type: "player.captureFrame", req: { video: KEY, maxEdge: 640 } });
  assert.ok(await until(() => frame.ready !== undefined));
  tool.stop();
  frame.ready?.(42.04);
  assert.deepEqual(await pending, { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(await tool.capture(), { ok: false, code: "VIDEO_CHANGED" });
  assert.deepEqual(encoded, []);
});
