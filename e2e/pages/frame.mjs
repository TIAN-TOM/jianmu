// 解释当前画面（测试构建打开了构建开关）：模拟的播放页上，真实的内容脚本截帧，结果从截帧指令一路看到侧边栏里的解释
// （点图标经真实的后台：打开侧边栏、截帧、看图探测和解释请求都发到模拟的模型服务）。
// 视频元素的画面用页面自己画布的媒体流喂，颜色是自造的，截出来的像素要和画上去的一致。
// 画面没加载好、视频对不上、加密播放、找不到视频各按各的拒绝。正在播广告、画布被污染、不在前台只在单元测试里造：
// 模拟的播放页不报广告，无头 Chrome 里切标签页、最小化窗口，页面都还算看得见。
import assert from "node:assert/strict";
import { videoKey } from "../../src/core/video-ref.ts";
import { INJECTED, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { ANTHROPIC, VIDEOS } from "../fixtures.mjs";
import { watchPage } from "../mock-server.mjs";
import { storedSettings } from "../settings.mjs";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const LAUNCHER = "pages/gallery.html";
const [FIRST_ID = "", SECOND_ID = ""] = Object.keys(VIDEOS);
const URL = watchPage(FIRST_ID);
const KEY = videoKey({ platform: "bilibili", videoId: FIRST_ID, segment: 1 });
// 画到画布上的颜色，截出来中间那个点要是它。
const FILL = [200, 48, 48];

/** 从扩展页面给播放页发截帧指令；画面只回前缀、尺寸和中间那个点的颜色。 */
const CAPTURE = `async (url, req) => {
  const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
  const reply = await chrome.tabs.sendMessage(tab.id, { type: "player.captureFrame", req });
  if (!reply?.ok) return reply;
  const { dataUrl, width, height, atSec, video } = reply.value;
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const center = [...context.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1).data.slice(0, 3)];
  return { ok: true, prefix: dataUrl.slice(0, 23), width, height, bitmap: [bitmap.width, bitmap.height], atSec, video, center };
}`;

/** 页面主世界里给视频元素喂一路画布的媒体流，等它出画面。 */
const FEED = `async (fill) => {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  const draw = () => {
    context.fillStyle = "rgb(" + fill.join(",") + ")";
    context.fillRect(0, 0, 640, 360);
    requestAnimationFrame(draw);
  };
  draw();
  const video = document.querySelector("video");
  video.srcObject = canvas.captureStream(30);
  await video.play();
  return true;
}`;

/** 加密播放：给视频元素挂上浏览器自带的明文密钥系统的钥匙；传 false 摘掉。挂着媒体流时挂不上钥匙，先摘下媒体流。 */
const KEYS = `async (on) => {
  const video = document.querySelector("video");
  video.pause();
  video.srcObject = null;
  if (!on) {
    await video.setMediaKeys(null);
    return video.mediaKeys === null;
  }
  const access = await navigator.requestMediaKeySystemAccess("org.w3.clearkey", [
    { initDataTypes: ["keyids"], videoCapabilities: [{ contentType: 'video/webm; codecs="vp8"' }] },
  ]);
  await video.setMediaKeys(await access.createMediaKeys());
  return video.mediaKeys !== null;
}`;

const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 12);

test("解释当前画面：播放页浮层多一个图标，截帧指令的拒绝分开报，截到的画面和画上去的一致，点图标经后台解释、结果在侧边栏", async ({ open, openPage, openSidePanel }) => {
  const launcher = await open(LAUNCHER);
  const before = await launcher.evaluate(`chrome.storage.local.get(null)`);
  const stored = await storedSettings(ANTHROPIC);
  await launcher.evaluate(`chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}).then(() => true)`);
  try {
    const page = await openPage(URL);
    const capture = (req) => launcher.call(CAPTURE, URL, req);

    // 浮层里笔记在上、解释画面在下，平时都藏着。
    const order = await page.waitFor(
      "浮层里两个图标",
      `(() => { const ids = [...document.querySelectorAll("#${INJECTED.overlay} > button")].map((node) => node.id); return ids.length === 2 ? ids : null; })()`,
    );
    assert.deepEqual(order, [INJECTED.noteButton, INJECTED.frameButton]);
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById("${INJECTED.overlay}")).visibility`), "hidden");
    assert.equal(await page.evaluate(`document.getElementById("${INJECTED.frameButton}").getAttribute("aria-label")`), "解释当前画面");

    // 视频元素还没有画面。
    assert.deepEqual(await capture({ video: KEY, maxEdge: 1456 }), { ok: false, code: "FRAME_NOT_READY" });
    // 指令里的视频不是这个页面上的。
    const other = videoKey({ platform: "bilibili", videoId: SECOND_ID, segment: 1 });
    assert.deepEqual(await capture({ video: other, maxEdge: 1456 }), { ok: false, code: "VIDEO_CHANGED" });

    await page.call(FEED, FILL);
    await page.waitFor("视频出了画面", `document.querySelector("video").readyState >= 2 && document.querySelector("video").videoWidth > 0`);
    const full = await capture({ video: KEY, maxEdge: 1456 });
    assert.equal(full.ok, true, JSON.stringify(full));
    assert.equal(full.prefix, "data:image/jpeg;base64,");
    assert.deepEqual([full.width, full.height, ...full.bitmap], [640, 360, 640, 360], "不放大");
    assert.equal(full.video, KEY);
    assert.ok(near(full.center, FILL), `截到的颜色 ${full.center} 和画上去的 ${FILL} 对不上`);
    const small = await capture({ video: KEY, maxEdge: 320 });
    assert.deepEqual([small.width, small.height], [320, 180], "按长边缩小");

    // 页面脚本派发的点击不算：不发给后台。
    await page.evaluate(`document.getElementById("${INJECTED.frameButton}").click(), true`);
    assert.equal(await page.evaluate(`document.querySelector(".${INJECTED.frameLabel}")?.textContent ?? ""`), "");

    // 真实点击：交给后台，后台先打开侧边栏，再向这个页面要一帧、请模型解释；图标上说结果去哪儿看。
    const box = await page.evaluate(`(() => { const r = document.getElementById("${INJECTED.frameButton}").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.clickAt(box.x, box.y);
    const hint = await page.waitFor(
      "图标说结果去哪儿看",
      `(() => { const text = document.querySelector(".${INJECTED.frameLabel}")?.textContent ?? ""; return /侧边栏|简幕图标/.test(text) ? text : null; })()`,
    );
    assert.match(hint, /结果在侧边栏|点简幕图标看结果/);
    // 侧边栏里出这一帧的解释，带时间，能跳回去。
    const panel = await openSidePanel(launcher);
    const explained = await panel.waitFor("侧边栏出画面解释", `document.querySelector(".frame-card-text")?.textContent ?? ""`);
    assert.match(explained, /模拟服务的画面解释/);
    assert.match(await panel.evaluate(`document.querySelector(".frame-card .stamp")?.textContent ?? ""`), /^\d+:\d{2}$/);

    // 加密播放：挂了钥匙就不截，摘掉以后又能截。
    assert.equal(await page.call(KEYS, true), true);
    assert.deepEqual(await capture({ video: KEY, maxEdge: 1456 }), { ok: false, code: "PROTECTED" });
    assert.equal(await page.call(KEYS, false), true);
    await page.call(FEED, FILL);
    await page.waitFor("摘掉钥匙后又出了画面", `document.querySelector("video").readyState >= 2`);
    assert.equal((await capture({ video: KEY, maxEdge: 1456 })).ok, true);

    // 视频元素没了。
    await page.evaluate(`document.querySelector("video").remove(), true`);
    assert.deepEqual(await capture({ video: KEY, maxEdge: 1456 }), { ok: false, code: "NO_VIDEO" });
  } finally {
    await launcher.evaluate(`chrome.storage.local.clear().then(() => chrome.storage.local.set(${JSON.stringify(before)})).then(() => true)`);
  }
});
