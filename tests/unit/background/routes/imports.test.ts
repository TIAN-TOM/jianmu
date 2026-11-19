// 导入和移除字幕文件的路由：只收侧边栏；确认前不收、什么都不存；只收认得的请求形状；导入以后取字幕拿到的是导入的那份，
// 导入和读取导入的字幕都不向平台发请求；导入、移除做成了告诉各页面这个视频的字幕换了；移除以后读到平台字幕时再说一次。
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

function appOn(script: Partial<SiteScript> = {}, options: FakeChromeOptions = {}, platform: "bilibili" | "youtube" = "bilibili") {
  const fakeSite = fakeSiteService(script);
  const site = platform === "bilibili" ? fakeSite : { ...fakeSite, service: { ...fakeSite.service, rules: { ...fakeSite.service.rules, platform } } };
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

test("导入和移除做成了才告诉各页面这个视频的字幕换了，没做成的不说", async () => {
  const { fake, send } = appOn({ videoInfo: () => failed("NEED_LOGIN") });
  const changed = () => fake.calls.broadcasts.filter((message) => (message as { type?: string }).type === "transcript.changed");
  assert.equal(((await send("imports.add", { ...ADD, text: "不是字幕" })) as { ok: boolean }).ok, false);
  assert.deepEqual(changed(), [], "解析不出来的文件没换字幕");
  assert.equal(((await send("imports.add", ADD)) as { ok: boolean }).ok, true);
  assert.deepEqual(changed(), [{ type: "transcript.changed", video: VIDEO }]);
  assert.equal(((await send("imports.remove", { video: VIDEO })) as { ok: boolean }).ok, true);
  assert.equal(changed().length, 2);
});

// 卡片收到「字幕换了」就做一次轻量读取，拿现在这份字幕的指纹和概览依据的比；之后不会自己再读。
for (const platform of ["bilibili", "youtube"] as const) {
  test(`${platform}：移除导入的字幕以后，平台字幕读到、写进本机时再告诉各页面一次，卡片这时重读才比得出旧字幕`, async () => {
    const video = platform === "bilibili" ? VIDEO : videoKey({ platform, videoId: "tube-sample" });
    const { fake, send } = appOn({}, {}, platform);
    const changed = () => fake.calls.broadcasts.filter((message) => (message as { type?: string }).type === "transcript.changed").length;
    const fingerprint = async (): Promise<string | undefined> =>
      ((await send("transcript.get", { video, mode: "light" }, senders.card())) as { ok: true; value: { transcriptFingerprint?: string } }).value.transcriptFingerprint;

    const platformRead = (await send("transcript.get", { video, mode: "full" })) as { ok: true; value: { transcript: { ref: { fingerprint: string } } } };
    const original = platformRead.value.transcript.ref.fingerprint;
    assert.equal(((await send("imports.add", { ...ADD, video })) as { ok: boolean }).ok, true);
    const imported = await fingerprint();
    assert.ok(imported && imported !== original, "导入以后卡片拿到的是导入那份的指纹");

    assert.equal(((await send("imports.remove", { video })) as { ok: boolean }).ok, true);
    const afterRemove = changed();
    // 移除的通知到的时候，侧边栏还没去读平台字幕：卡片这时重读，拿不到现在这份的指纹。
    assert.equal(await fingerprint(), undefined);

    // 侧边栏接着读平台字幕，写进本机。
    assert.equal(((await send("transcript.get", { video, mode: "full" })) as { ok: boolean }).ok, true);
    assert.equal(changed(), afterRemove + 1, "读到的平台字幕写进本机时再说一次");
    assert.equal(await fingerprint(), original, "卡片这时重读，拿到平台字幕的指纹");

    // 之后再读都是本机已有的，不再说。
    await send("transcript.get", { video, mode: "full" });
    assert.equal(changed(), afterRemove + 1, "只说一次，卡片不反复重读");
  });
}
