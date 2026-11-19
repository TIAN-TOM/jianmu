// 打开就出结论经页面读 YouTube 字幕：本机有就不碰页面；没有就让视频页点开文字稿面板再读，只在这次点开了的时候读完让它关上；
// 页面还没接上、在播广告、正在换视频时回 later，不读。时长问视频页，页面没回话也是 later。页面和取字幕服务都是替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPageTranscript } from "../../../../src/background/services/page-transcript.ts";
import type { VideoRef } from "../../../../src/core/video-ref.ts";
import type { TranscriptReply } from "../../../../src/shared/messages/transcript.ts";
import type { SiteResult, VideoInfo } from "../../../../src/sites/types.ts";
import { fakeSiteService, sampleInfo } from "../../../helpers/fake-site-service.ts";

const REF: VideoRef = { platform: "youtube", videoId: "tube-sample" };
const TAB = 9;
const READ = { ok: true, value: { info: { durationSec: 600 } } } as unknown as TranscriptReply;
const MISSING = { ok: false, code: "NOT_CACHED" } as TranscriptReply;

function setup(options: { readonly answer?: (message: unknown) => unknown; readonly cached?: boolean; readonly info?: () => SiteResult<VideoInfo> } = {}) {
  const asked: string[] = [];
  const reads: { mode: string; tabId?: number | undefined }[] = [];
  const site = fakeSiteService(options.info ? { videoInfo: options.info } : {});
  const service = { ...site.service, rules: { ...site.service.rules, platform: "youtube" as const } };
  const page = createPageTranscript({
    async ask(tabId, message) {
      assert.equal(tabId, TAB);
      asked.push(String((message as { type: string }).type));
      if (!options.answer) throw new Error("内容脚本还没接上");
      return options.answer(message);
    },
    transcript: {
      async get(_ref, { mode, tabId }) {
        reads.push({ mode, tabId });
        if (mode === "local") return options.cached ? READ : MISSING;
        return READ;
      },
    },
    sites: {
      service: (platform) => (platform === "youtube" ? service : undefined),
      ctx: (_platform, { signal }) => ({ fetch: () => Promise.reject(new Error("不发请求")), signal, backoff: { admit: async () => ({ ok: true }), trip: async () => {}, clear: async () => {} } }),
    },
  });
  return { page, asked, reads };
}

const outcome = (value: string) => () => ({ outcome: value });

test("本机有字幕（缓存、内存、导入的文件）：直接用，不碰页面", async () => {
  const { page, asked, reads } = setup({ cached: true, answer: outcome("opened") });
  assert.equal(await page.read(REF, TAB), READ);
  assert.deepEqual(asked, []);
  assert.deepEqual(reads, [{ mode: "local", tabId: undefined }]);
});

test("这次点开了：经这个标签页读，读完让页面关上", async () => {
  const { page, asked, reads } = setup({ answer: (message) => ({ outcome: (message as { type: string }).type === "youtube.openTranscript" ? "opened" : "closed" }) });
  assert.equal(await page.read(REF, TAB), READ);
  assert.deepEqual(asked, ["youtube.openTranscript", "youtube.closeTranscript"]);
  assert.deepEqual(reads.at(-1), { mode: "full", tabId: TAB });
});

test("本来就开着、点不开、没有入口、搜索框里有字：照常去读，不叫页面关", async () => {
  for (const value of ["already-open", "not-opened", "no-entry", "searching"]) {
    const { page, asked, reads } = setup({ answer: outcome(value) });
    assert.equal(await page.read(REF, TAB), READ, value);
    assert.deepEqual(asked, ["youtube.openTranscript"], value);
    assert.equal(reads.at(-1)?.mode, "full", value);
  }
});

test("页面没接上、在播广告、正在换视频、回话认不出：说明是哪一种，过一会儿再来，不读", async () => {
  for (const [answer, later] of [[undefined, "no-page"], [outcome("ad"), "ad"], [outcome("video-changed"), "video-changed"], [() => undefined, "no-page"]] as const) {
    const { page, reads } = setup(answer ? { answer } : {});
    assert.deepEqual(await page.read(REF, TAB), { later });
    assert.deepEqual(reads, [{ mode: "local", tabId: undefined }]);
  }
});

test("时长问视频页：有就用；页面上还没有时长是 null；页面没回话是 later", async () => {
  assert.equal(await setup({ info: () => ({ ok: true, value: sampleInfo(REF, { durationSec: 1800 }) }) }).page.duration(REF, TAB), 1800);
  assert.equal(await setup({ info: () => ({ ok: true, value: sampleInfo(REF, { durationSec: 0 }) }) }).page.duration(REF, TAB), null);
  assert.equal(await setup({ info: () => ({ ok: false, code: "UNAVAILABLE", detail: "no-page" }) }).page.duration(REF, TAB), "later");
  assert.equal(await setup({ info: () => ({ ok: false, code: "VIDEO_CHANGED" }) }).page.duration(REF, TAB), "later");
  assert.equal(await setup({ info: () => ({ ok: false, code: "UNAVAILABLE", detail: "stale" }) }).page.duration(REF, TAB), null);
});
