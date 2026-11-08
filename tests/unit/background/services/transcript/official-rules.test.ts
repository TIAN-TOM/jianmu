// 官方总结的几条新规矩：附带字幕的兜底在生产装配里关着；被限流、要登录时不兜底；换过媒体版本的官方总结不沿用；
// 先交了字幕的那次，官方总结回来后内存里记着的那份也填上；占位只等还在路上的那次，不另发请求。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../../../src/background/app.ts";
import { OFFICIAL_GRACE_MS } from "../../../../../src/background/services/transcript/official.ts";
import { videoKey } from "../../../../../src/core/video-ref.ts";
import { SETTINGS_STORAGE_KEY } from "../../../../../src/shared/names.ts";
import type { Cue, OfficialSummary, SiteResult } from "../../../../../src/sites/types.ts";
import { CONFIRMED, createFakeChrome, senders } from "../../../../helpers/chrome.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { failed, fakeSiteService } from "../../../../helpers/fake-site-service.ts";
import { cachedRow, harness, REF, sampleInfo, START, view, ZH } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const CUES: Cue[] = [
  { start: 0, duration: 2, text: "官方总结里的第一句" },
  { start: 2, duration: 2, text: "官方总结里的第二句" },
];
const SUMMARY: OfficialSummary = { status: "ok", summary: "官方摘要", outline: [], cues: CUES };
const ok = <T>(value: T): SiteResult<T> => ({ ok: true, value: structuredClone(value) });

test("生产装配里附带字幕的兜底关着：播放器没有字幕、官方总结带着字幕，也照旧报没有字幕", async () => {
  const site = fakeSiteService({ tracks: () => ok([]), officialSummary: () => ok(SUMMARY) });
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, site: site.service });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const video = videoKey(REF);

  const reply = (await app.dispatch({ type: "transcript.get", req: { video, mode: "full" } }, senders.panel())) as {
    ok: boolean;
    code?: string;
    official?: { status: string };
  };
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "NO_CAPTIONS");
  assert.equal(reply.official?.status, "ok", "官方总结照样带回去");
  assert.equal(site.count("readCaptions"), 0);
});

test("被限流、要登录时不拿附带字幕兜底，照旧报原来的错", async () => {
  for (const code of ["RATE_LIMITED", "NEED_LOGIN"] as const) {
    for (const step of ["tracks", "captions"] as const) {
      const h = harness({ officialCaptionsFallback: true, site: { officialSummary: () => ok(SUMMARY), [step]: () => failed(code) } });
      const reply = await h.service.get(REF, { mode: "full" });
      assert.equal(!reply.ok && reply.code, code, `${step} ${code}`);
      assert.deepEqual(await h.rows(), []);
    }
  }
});

test("缓存里的官方总结是别的媒体版本时不沿用，按这次读到的视频信息重新问", async () => {
  const seed = cachedRow(ZH, {
    info: sampleInfo(REF, { mediaVersion: "replaced-version" }),
    official: { status: "ok", summary: "旧版本的官方摘要", outline: [], hasCaptions: false, fetchedAt: START },
  });
  const h = harness({ seed: [seed], site: { officialSummary: () => ok({ ...SUMMARY, summary: "这一版的官方摘要" }) } });

  const result = view(await h.service.get(REF, { mode: "full", lang: "en-US" }));
  assert.equal(result.official?.summary, "这一版的官方摘要");
  const [asked] = h.site.calls.filter((call) => call.method === "readOfficialSummary");
  assert.equal(asked?.info?.mediaVersion, sampleInfo(REF).mediaVersion);
});

test("官方总结的指纹只看内容：同样的摘要和提纲指纹相同，内容变了指纹跟着变", async () => {
  const outline = [{ title: "提纲", timestamp: 30, points: [{ timestamp: 30, content: "要点" }] }];
  const read = async (summary: OfficialSummary) => view(await harness({ site: { officialSummary: () => ok(summary) } }).service.get(REF, { mode: "full" }));
  const base = (await read({ ...SUMMARY, outline })).official?.fingerprint;
  assert.match(base ?? "", /^[0-9a-f]{16}$/);
  assert.equal((await read({ ...SUMMARY, outline, cues: [] })).official?.fingerprint, base, "附带的字幕不算");
  assert.notEqual((await read({ ...SUMMARY, outline, summary: "别的摘要" })).official?.fingerprint, base);
  assert.notEqual((await read({ ...SUMMARY, outline: [{ ...outline[0], timestamp: 31 } as (typeof outline)[number]] })).official?.fingerprint, base);
});

test("时间轴对不上的字幕只记在内存：迟到的官方总结回来后，内存里那份也填上", async () => {
  const held = deferred();
  const wrong: Cue[] = [
    { start: 0, duration: 2, text: "错的一" },
    { start: 900, duration: 2, text: "错的二" },
  ];
  const h = harness({ site: { captions: () => ok(wrong), officialSummary: () => held.promise.then(() => ok(SUMMARY)) } });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  h.timers.advance(OFFICIAL_GRACE_MS);
  const first = view(await pending);
  assert.equal(first.subtitleMismatch, true);
  assert.equal(first.official?.status, "pending");

  held.resolve();
  assert.ok(await until(async () => view(await h.service.get(REF, { mode: "full" })).official?.status === "ok"), "内存里那份换上了回来的官方总结");
  assert.deepEqual(await h.rows(), [], "对不上的照旧不进缓存");
  assert.equal(h.site.count("readOfficialSummary"), 1);
});

test("时间轴对不上的字幕还没记进内存、迟到的官方总结就回来了：记下的那份照样换上回来的官方总结", async () => {
  const held = deferred();
  const gate = deferred();
  const wrong: Cue[] = [
    { start: 0, duration: 2, text: "错的一" },
    { start: 900, duration: 2, text: "错的二" },
  ];
  let loads = 0;
  let updates = 0;
  const h = harness({
    site: { captions: () => ok(wrong), officialSummary: () => held.promise.then(() => ok(SUMMARY)) },
    wrapCache: (inner) => ({
      ...inner,
      // 第 2 次读缓存是对不上的字幕记进内存前的核对：在这里卡住，让官方总结先回来。
      async load(key) {
        loads += 1;
        if (loads === 2) await gate.promise;
        return inner.load(key);
      },
      async update(key, mutate, options) {
        updates += 1;
        return inner.update(key, mutate, options);
      },
    }),
  });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  h.timers.advance(OFFICIAL_GRACE_MS);
  assert.ok(await until(() => loads === 2), "停在记进内存前的核对");

  held.resolve();
  assert.ok(await until(() => updates === 1), "回填已经试过写缓存，内存里还没有这份");
  gate.resolve();
  assert.equal(view(await pending).official?.status, "pending");

  assert.ok(await until(async () => view(await h.service.get(REF, { mode: "cache-only" })).official?.status === "ok"), "只读缓存的读取看得到回来的官方总结");
  assert.equal(view(await h.service.get(REF, { mode: "full" })).official?.summary, "官方摘要");
  assert.equal(h.site.count("readOfficialSummary"), 1);
});

test("缓存里是占位：命中缓存的读取等还在路上的那次，不另发请求；只读缓存的读取也只等它", async () => {
  const held = deferred();
  const h = harness({ site: { officialSummary: () => held.promise.then(() => ok(SUMMARY)) } });
  const pending = h.service.get(REF, { mode: "full" });
  assert.ok(await until(() => h.timers.due(OFFICIAL_GRACE_MS) === 1));
  h.timers.advance(OFFICIAL_GRACE_MS);
  await pending;

  const full = h.service.get(REF, { mode: "full" });
  const cacheOnly = h.service.get(REF, { mode: "cache-only" });
  held.resolve();
  assert.equal(view(await full).official?.summary, "官方摘要");
  assert.equal(view(await cacheOnly).official?.summary, "官方摘要");
  assert.equal(h.site.count("readOfficialSummary"), 1, "并进还在路上的那次");
  assert.equal(h.ctxs.length, 1, "没有为重问另建读取环境");
});

test("缓存里是兜底存下的官方 AI 字幕：点名语言时不拿它顶替，去平台读那条轨", async () => {
  const h = harness({ officialCaptionsFallback: true, site: { tracks: () => ok([]), officialSummary: () => ok(SUMMARY) } });
  assert.equal(view(await h.service.get(REF, { mode: "full" })).transcript.ref.kind, "official-ai");

  h.site.script.tracks = () => ok([ZH]);
  const named = view(await h.service.get(REF, { mode: "full", lang: "zh-CN" }));
  assert.equal(named.transcript.ref.kind, "human");
  assert.equal(named.fromCache, false);
  assert.equal(h.site.count("readCaptions"), 1);
});
