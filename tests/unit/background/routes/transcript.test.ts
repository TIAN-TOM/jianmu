// 取字幕和查原视频还在不在的路由：确认前不读、不发平台请求；只收认得的请求形状；卡片只能用轻量读取，
// 只带视频和读取方式；标签页标题只在过了启用闸门、视频信息读不到时才读。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../src/background/app.ts";
import type { MessageSender } from "../../../../src/background/senders.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, STALE_CONFIRMATION, type FakeChromeOptions } from "../../../helpers/chrome.ts";
import { failed, fakeSiteService, SAMPLE_ID, type SiteScript } from "../../../helpers/fake-site-service.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_ID });
const TAB = 41;

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
  test(`${state}：取字幕和查原视频都回还没启用，不建读取环境、不发平台请求、不读标签页`, async () => {
    const { site, fake, send } = appOn({}, { local: structuredClone(local), tabTitles: { [TAB]: "标题" } });
    assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "full", tabId: TAB }), { ok: false, code: "NOT_ENABLED" });
    assert.deepEqual(await send("video.checkAvailable", { video: VIDEO }), { ok: false, code: "NOT_ENABLED" });
    assert.equal(site.calls.length, 0);
    assert.equal(fake.calls.siteCtxs.length, 0);
    assert.deepEqual(fake.calls.tabGets, []);
  });
}

test("确认以后侧边栏取得到字幕，读到的写进本机缓存，再取就命中缓存", async () => {
  const { site, send } = appOn();
  const first = (await send("transcript.get", { video: VIDEO, mode: "full" })) as { ok: true; value: { fromCache: boolean; transcript: { cues: unknown[] } } };
  assert.equal(first.ok, true);
  assert.equal(first.value.fromCache, false);
  assert.equal(first.value.transcript.cues.length, 2);

  const again = (await send("transcript.get", { video: VIDEO, mode: "cache-only" })) as { ok: true; value: { fromCache: boolean } };
  assert.equal(again.value.fromCache, true);
  assert.equal(site.count("readVideoInfo"), 1);
});

test("取字幕只收认得的请求形状：视频、读取方式、语言、刷新和标签页，别的都拒", async () => {
  const { site, send } = appOn();
  for (const req of [
    {},
    { video: VIDEO },
    { video: "bilibili:不是视频:p1", mode: "full" },
    { video: VIDEO, mode: "light", lang: "zh-CN" },
    { video: VIDEO, mode: "light", fresh: true },
    { video: VIDEO, mode: "light", tabId: TAB },
    { video: VIDEO, mode: "full", lang: "zh CN" },
    { video: VIDEO, mode: "full", lang: "x".repeat(33) },
    { video: VIDEO, mode: "full", fresh: "yes" },
    { video: VIDEO, mode: "full", tabId: -1 },
    { video: VIDEO, mode: "full", tabId: 1.5 },
    { video: VIDEO, mode: "full", url: "https://watch.example/x" },
    [VIDEO],
  ]) {
    assert.deepEqual(await send("transcript.get", req), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.equal(site.calls.length, 0);
  const ok = (await send("transcript.get", { video: VIDEO, mode: "full", lang: "zh-CN", fresh: true, tabId: TAB })) as { ok: boolean };
  assert.equal(ok.ok, true);
});

test("卡片只能用轻量读取：只问视频信息和官方总结，回复里没有字幕；完整读取、只读缓存和多带字段的都拒", async () => {
  const { site, send } = appOn();
  for (const req of [
    { video: VIDEO, mode: "full" },
    { video: VIDEO, mode: "cache-only" },
    { video: VIDEO, mode: "light", tabId: TAB },
  ]) {
    assert.deepEqual(await send("transcript.get", req, senders.card()), { ok: false, code: "INVALID_REQUEST" }, JSON.stringify(req));
  }
  assert.equal(site.calls.length, 0);

  const reply = (await send("transcript.get", { video: VIDEO, mode: "light" }, senders.card())) as { ok: true; value: Record<string, unknown> };
  assert.equal(reply.ok, true);
  assert.equal(reply.value["mode"], "light");
  assert.equal(reply.value["hasTranscript"], false);
  for (const field of ["transcript", "tracks", "chapters"]) assert.equal(field in reply.value, false, field);
  assert.deepEqual(site.calls.map((call) => call.method).sort(), ["readOfficialSummary", "readVideoInfo"]);
});

test("卡片开关关着时卡片的轻量读取也不收，不发平台请求", async () => {
  const { site, send } = appOn({}, { local: { [SETTINGS_STORAGE_KEY]: { ...CONFIRMED, inPageCard: false } } });
  assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "light" }, senders.card()), { ok: false, code: "CARD_DISABLED" });
  assert.equal(site.calls.length, 0);
});

test("内容脚本和认不出的扩展页面取不了字幕，卡片和内容脚本查不了原视频", async () => {
  const { site, send } = appOn();
  for (const sender of [senders.content(), senders.otherPage()]) {
    assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "full" }, sender), { ok: false, code: "FORBIDDEN" });
  }
  for (const sender of [senders.card(), senders.content()]) {
    assert.deepEqual(await send("video.checkAvailable", { video: VIDEO }, sender), { ok: false, code: "FORBIDDEN" });
  }
  assert.equal(site.calls.length, 0);
});

test("没登录时取字幕只提示登录：带回标签页的标题，只问一次视频信息", async () => {
  const { site, fake, send } = appOn({ videoInfo: () => failed("NEED_LOGIN") }, { tabTitles: { [TAB]: "视频页的标题" } });
  assert.deepEqual(await send("transcript.get", { video: VIDEO, mode: "full", tabId: TAB }), { ok: false, code: "NEED_LOGIN", tabTitle: "视频页的标题" });
  assert.deepEqual(site.calls.map((call) => call.method), ["readVideoInfo"]);
  assert.deepEqual(fake.calls.tabGets.map((call) => call.value), [TAB]);
  assert.ok(fake.calls.tabGets.every((call) => call.whileConfirmed));
});

test("查原视频：没登录、被限流都当作还在，只有平台说找不到才算不在", async () => {
  for (const [script, available] of [
    [{ videoInfo: () => failed("NEED_LOGIN") }, true],
    [{ videoInfo: () => failed("RATE_LIMITED") }, true],
    [{ videoInfo: () => failed("NOT_FOUND") }, false],
    [{}, true],
  ] as const) {
    const { send } = appOn(script);
    for (const sender of [senders.panel(), senders.options(), senders.triage()]) {
      assert.deepEqual(await send("video.checkAvailable", { video: VIDEO }, sender), { ok: true, value: { available } });
    }
  }
  const { send } = appOn();
  assert.deepEqual(await send("video.checkAvailable", { video: VIDEO, extra: 1 }), { ok: false, code: "INVALID_REQUEST" });
});
