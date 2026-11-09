// 概览落库的规矩：章节和结论各看写它的任务的创建时间，较早创建的不覆盖较晚的；依据字幕的结论优先于只依据官方总结的；
// 官方总结写的结论先留着，等这次的结论写好再换；章节依据的字幕换过时不按区间补块；错误日志里不带密钥。
import assert from "node:assert/strict";
import { test } from "node:test";
import { planChapters, planDraft, planVerdict, verdictWins } from "../../../../../src/background/services/overview/persist.ts";
import type { OverviewPart, OverviewRecord } from "../../../../../src/core/notes/records.ts";
import { deferred } from "../../../../helpers/deferred.ts";
import { SAMPLE_KEY } from "../../../../helpers/fake-model-service.ts";
import { codeOf, overviewHarness, START, titles, value, verdictReply, VIDEO } from "../../../../helpers/overview-service.ts";
import { harness as transcriptHarness, KEY as TRANSCRIPT_KEY } from "../../../../helpers/transcript-service.ts";
import { until } from "../../../../helpers/wait-until.ts";

const GEN = { feature: "analysis", promptVersion: "p1", model: "m", effort: "off" } as const;
const TRANSCRIPT = { video: VIDEO, kind: "human", lang: "zh-CN", fingerprint: "fingerprint-zh" } as const;
const byTranscript = (taskCreatedAt: number): OverviewPart => ({ derived: { basis: { source: "transcript", transcript: TRANSCRIPT }, gen: GEN }, taskCreatedAt });
const byOfficial = (taskCreatedAt: number): OverviewPart => ({ derived: { basis: { source: "official-summary", video: VIDEO, fingerprint: "official" }, gen: GEN }, taskCreatedAt });
const FIELDS = { video: VIDEO, title: "测试视频", author: "UP 主" };
const chapter = (title: string) => ({ chapters: [{ title, timestampSeconds: 0 }], keyQuotes: [] });

function stored(extra: Partial<OverviewRecord> = {}): OverviewRecord {
  return { schemaVersion: 1, videoKey: VIDEO, snapshot: { title: "测试视频", author: "UP 主" }, analysis: chapter("现有"), updatedAt: 1, ...extra };
}

test("较早创建的任务不覆盖较晚的：章节、草稿和结论各看写它的任务", () => {
  const newer = stored({ parts: { chapters: byTranscript(200), verdict: byTranscript(200) }, analysis: { ...chapter("较晚的"), verdict: { summary: "较晚的结论" } } });
  assert.equal(planChapters(newer, FIELDS, { analysis: chapter("较早的"), failures: [], part: byTranscript(100) }, 5), null);
  assert.equal(planDraft(newer, { analysis: chapter("较早的"), failures: [], part: byTranscript(100) }), null);
  assert.equal(planVerdict(newer, { verdict: { summary: "较早的结论" }, part: byTranscript(100), chaptersCreatedAt: 100, fromDraft: false }, 5), null);

  const written = planChapters(newer, FIELDS, { analysis: chapter("更晚的"), failures: [], part: byTranscript(300) }, 5);
  assert.deepEqual(titles(written), ["更晚的"]);
  assert.equal(written?.analysis.verdict?.summary, "较晚的结论", "已有的结论先留着，等这次的结论写好再换");
  assert.equal(written?.parts?.chapters?.taskCreatedAt, 300);
});

test("结论只放在这次写的章节上：生效的章节换成了别的任务写的，这次的结论不往上放", () => {
  const replaced = stored({ parts: { chapters: byTranscript(300) } });
  assert.equal(planVerdict(replaced, { verdict: { summary: "旧任务的结论" }, part: byTranscript(300), chaptersCreatedAt: 100, fromDraft: false }, 5), null);
  const draft = stored({ draft: { analysis: chapter("别人的草稿"), chapters: byTranscript(300) } });
  assert.equal(planVerdict(draft, { verdict: { summary: "旧任务的结论" }, part: byTranscript(100), chaptersCreatedAt: 100, fromDraft: true }, 5), null);
});

test("依据字幕的结论优先于只依据官方总结的；同一类的较晚创建的赢；旧记录没写来历的谁都能换", () => {
  assert.equal(verdictWins(byOfficial(500), byTranscript(100)), true, "依据字幕的哪怕创建得早也换掉官方总结的");
  assert.equal(verdictWins(byTranscript(100), byOfficial(500)), false, "官方总结的不盖掉依据字幕的");
  assert.equal(verdictWins(byTranscript(100), byTranscript(200)), true);
  assert.equal(verdictWins(byTranscript(200), byTranscript(100)), false);
  assert.equal(verdictWins(undefined, byOfficial(1)), true);
});

test("已有的结论是用官方总结写的：新概览的章节先接上它，依据字幕的结论写好再换掉", async () => {
  const gate = deferred();
  const official = stored({ analysis: { chapters: [], keyQuotes: [], verdict: { summary: "官方总结写的结论", source: "official" } }, parts: { verdict: byOfficial(START - 100) } });
  const h = overviewHarness({ records: [official], respond: async ({ isVerdict }) => (isVerdict ? (await gate.promise, verdictReply("按字幕写的")) : undefined) });
  const { result } = h.generate();
  assert.ok(await until(() => h.updates().length > 0));
  const early = await h.record();
  assert.deepEqual(titles(early), ["章@0", "章@150"]);
  assert.equal(early?.analysis.verdict?.summary, "官方总结写的结论", "结论写好之前先留着官方总结那条");
  gate.resolve();
  value(await result);
  const done = await h.record();
  assert.equal(done?.analysis.verdict?.summary, "按字幕写的");
  assert.equal(done?.parts?.verdict?.derived.basis.source, "transcript");
});

test("生效章节依据的字幕换过：补失败块要求重新生成整份，不拿两份字幕的内容拼在一起", async () => {
  const changed = stored({
    analysisFailures: [{ index: 1, startSeconds: 150, endSeconds: 600 }],
    parts: { chapters: { derived: { basis: { source: "transcript", transcript: { ...TRANSCRIPT, fingerprint: "另一份字幕" } }, gen: GEN }, taskCreatedAt: 1 } },
  });
  const h = overviewHarness({ records: [changed] });
  assert.equal(codeOf(await h.retry().result), "FAILED_CHUNKS_MISMATCH");
  assert.equal(h.asks.length, 0);
});

test("失败原因里带着密钥：错误日志只记类别，搜不到密钥", async () => {
  const h = overviewHarness({
    respond: ({ isVerdict }) => {
      if (isVerdict) return undefined;
      throw Object.assign(new Error(`rejected credential: ${SAMPLE_KEY}`), { status: 500 });
    },
  });
  assert.equal(codeOf(await h.generate().result), "AI_SERVICE_ERROR");
  assert.ok(h.logs.length > 0, "真正的失败记了日志");
  assert.ok(!JSON.stringify(h.logs).includes(SAMPLE_KEY), JSON.stringify(h.logs));
});

test("没登录时只报需要登录：不改用官方总结或标题简介写概览，一个模型请求都不发", async () => {
  const transcript = transcriptHarness({ site: { videoInfo: () => ({ ok: false, code: "NEED_LOGIN" }) } });
  const h = overviewHarness({ transcript: transcript.service });
  const result = await h.service.generate(await h.register(TRANSCRIPT_KEY), TRANSCRIPT_KEY, { fresh: false });
  assert.deepEqual(result, { ok: false, code: "NEED_LOGIN" }, "不带视频信息、标签页标题这些读字幕时顺手带回的东西");
  assert.equal(h.asks.length, 0);
  assert.equal(await h.record(TRANSCRIPT_KEY), null);
  assert.deepEqual(transcript.site.calls.map((call) => call.method), ["readVideoInfo"], "官方总结也没去问");
});
