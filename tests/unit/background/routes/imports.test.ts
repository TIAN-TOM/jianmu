// 导入和移除字幕文件的路由：只收侧边栏；确认前不收、什么都不存；只收认得的请求形状；导入以后取字幕拿到的是导入的那份，
// 导入和读取导入的字幕都不向平台发请求。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import type { MessageSender } from "../../../../src/background/senders.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION, tubeUrl, type FakeChromeOptions } from "../../../helpers/chrome.ts";
import { failed, fakeSiteService, SAMPLE_ID, type SiteScript } from "../../../helpers/fake-site-service.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_ID });
const SRT = "1\n00:00:01,000 --> 00:00:04,000\n导入的第一句\n";
const ADD = { video: VIDEO, fileName: "课程.srt", text: SRT };

function appOn(script: Partial<SiteScript> = {}, options: FakeChromeOptions = {}) {
  const site = fakeSiteService(script);
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, site: site.service, ...options });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const send = (type: string, req: unknown, sender: MessageSender = senders.panel()) => app.dispatch({ type, req }, sender);
  return { site, fake, send };
}

for (const [state, local] of [
  ["从没确认", {}],
  ["确认过期", { [SETTINGS_STORAGE_KEY]: STALE_CONFIRMATION }],
] as const) {
  test(`${state}：导入和移除都回还没启用，什么都不存`, async () => {
    const { site, send } = appOn({ videoInfo: () => failed("NEED_LOGIN") }, { local: structuredClone(local) });
    assert.deepEqual(await send("imports.add", ADD), { ok: false, code: "NOT_ENABLED" });
    assert.deepEqual(await send("imports.remove", { video: VIDEO }), { ok: false, code: "NOT_ENABLED" });
    assert.equal(site.calls.length, 0);

    assert.equal(((await send("activation.confirm", {})) as { ok: boolean }).ok, true);
    assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "full" }), { ok: false, code: "NEED_LOGIN" }, "确认以后读取用不到确认前送来的文件");
  });
}

test("没登录时侧边栏导入字幕，取字幕拿到导入的那份，不向平台发请求；移除以后才去平台读", async () => {
  const { site, send } = appOn({ videoInfo: () => failed("NEED_LOGIN") });
  assert.deepEqual(await send("imports.add", ADD), { ok: true, value: { fileName: "课程.srt", entries: 1 } });
  const read = (await send("transcript.get", { video: VIDEO, mode: "full", fresh: true })) as { ok: true; value: { transcript: { ref: { kind: string }; fileName: string } } };
  assert.equal(read.value.transcript.ref.kind, "imported");
  assert.equal(read.value.transcript.fileName, "课程.srt");
  assert.equal(site.calls.length, 0);

  assert.deepEqual(await send("imports.remove", { video: VIDEO }), { ok: true, value: {} });
  assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "full" }), { ok: false, code: "NEED_LOGIN" });
  assert.deepEqual(
    site.calls.map((call) => call.method),
    ["readVideoInfo"],
    "移除以后才去平台读，没登录只问一次",
  );
});

test("导入和移除只收认得的请求形状", async () => {
  const { send } = appOn();
  for (const req of [
    {},
    { video: VIDEO, fileName: "课程.srt" },
    { video: VIDEO, text: SRT },
    { ...ADD, video: "bilibili:不是视频:p1" },
    { ...ADD, fileName: "" },
    { ...ADD, fileName: "x".repeat(1001) },
    { ...ADD, text: 3 },
    { ...ADD, tabId: 1 },
    [ADD],
  ]) {
    assert.deepEqual(await send("imports.add", req), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req).slice(0, 80));
  }
  for (const req of [{}, { video: VIDEO, extra: 1 }, { video: 3 }]) {
    assert.deepEqual(await send("imports.remove", req), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "cache-only" }), { ok: false, code: "NOT_CACHED" });
});

test("导入和移除只收侧边栏：设置页、粗筛页、卡片和内容脚本发不了", async () => {
  const { site, send } = appOn();
  for (const sender of [senders.options(), senders.triage(), senders.otherPage(), senders.card(), senders.content(), senders.content(tubeUrl())]) {
    assert.deepEqual(await send("imports.add", ADD, sender), { ok: false, code: "FORBIDDEN" });
    assert.deepEqual(await send("imports.remove", { video: VIDEO }, sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "cache-only" }), { ok: false, code: "NOT_CACHED" });
  assert.equal(site.calls.length, 0);
});
