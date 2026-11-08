// 新备份格式：只带笔记、概览和问答，记录过一遍校验只留认得的字段；先认格式再读，坏记录逐条跳过。
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKUP_KIND, BACKUP_VERSION, buildBackup, readBackup } from "../../../../src/core/backup/format.ts";
import type { ImportedBackup } from "../../../../src/core/backup/records.ts";
import { notesAsMarkdown } from "../../../../src/core/notes/markdown.ts";
import type { Derived, NoteRecord, OverviewRecord } from "../../../../src/core/notes/records.ts";
import type { QaRecord } from "../../../../src/core/qa/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";
const KEY_A = videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment: 2 });
const KEY_Y = videoKey({ platform: "youtube", videoId: "sample_id" });
const EVIL_URL = "https://login.example/phish?t=65";
const EXPORTED_AT = Date.UTC(2026, 10, 1, 8, 0, 0);
const DERIVED: Derived = {
  basis: { source: "transcript", transcript: { video: KEY_A, kind: "human", lang: "zh-CN", fingerprint: "0123456789abcdef" } },
  gen: { feature: "note-polish", promptVersion: "1", model: "sample-model", effort: "off" },
};

const NOTE: NoteRecord = {
  id: "note_sample-a",
  kind: "note",
  origin: "user",
  video: KEY_A,
  snapshot: { title: "番茄搭架子入门", author: "菜园实验室" },
  atSec: 65,
  text: "看这里",
  quote: "竹竿间距留够 40 厘米",
  derived: DERIVED,
  createdAt: 1000,
  updatedAt: 2000,
};

const OVERVIEW: OverviewRecord = {
  schemaVersion: 1,
  videoKey: KEY_Y,
  snapshot: { title: "Sample talk", author: "Sample channel" },
  analysis: {
    chapters: [{ title: "开场", summary: "讲了为什么", timestampSeconds: 0, timestamp: "0:00" }],
    keyQuotes: [{ quote: "先想清楚再动手。", timestampSeconds: 12, timestamp: "0:12" }],
    verdict: { summary: "讲清了做计划的方法。", value: "三步法", verdict: "值得看完整视频", reason: "例子具体" },
  },
  analysisFailures: [{ index: 1, startSeconds: 600, endSeconds: 900, reason: "超时" }],
  updatedAt: 3000,
};

const QA: QaRecord = {
  id: "qa_sample-a",
  video: KEY_A,
  question: "竹竿插多深？",
  answer: "三十厘米左右 [1:20]。",
  citations: [{ startSeconds: 80, quote: "竹竿插到三十厘米左右" }],
  clickable: [80],
  createdAt: 4000,
};

function read(payload: unknown): ImportedBackup {
  const result = readBackup(payload);
  if (!result.ok) assert.fail(`读备份失败：${result.code} ${result.detail ?? ""}`);
  return result.value;
}

test("导出备份和 Markdown 都不沿用存着的链接字段", () => {
  // 仓储读出来的笔记带着现拼的链接，旧库里还可能留着旧链接字段：都不该进备份。
  const stored = { ...NOTE, url: EVIL_URL, timestampedUrl: EVIL_URL };
  const backup = buildBackup({ notes: [stored] }, EXPORTED_AT);
  assert.equal(JSON.stringify(backup).includes("login.example"), false);
  assert.deepEqual(backup.notes, [NOTE]);

  const markdown = notesAsMarkdown([stored], VIDEO_BASE);
  assert.equal(markdown.includes("login.example"), false, markdown);
  assert.match(markdown, /- \[1:05\]\(https:\/\/video\.example\/BV1Sample000\?p=2&t=65\) 看这里/);
});

test("导出的备份不再带提示词：存储里留着旧版自定义的也不导出", () => {
  const source = { notes: [], overviews: [], qa: [], analysisSystemPrompt: "更早的", promptOverrides: { "analysis.md": "旧版自定义" } };
  const backup = buildBackup(source, EXPORTED_AT);
  assert.deepEqual(Object.keys(backup).sort(), ["exportedAt", "kind", "notes", "overviews", "qa", "version"]);
  assert.doesNotMatch(JSON.stringify(backup), /旧版自定义|更早的/);
});

test("导出的备份不带密钥，也不带按功能选的模型和存储里留着的旧提示词", () => {
  const source = {
    notes: [{ ...NOTE, apiKey: "sk-sample-backup-secret" }],
    overviews: [{ ...OVERVIEW, featureModels: { overview: "sample-fast-model" } }],
    qa: [{ ...QA, prompt: "自定义问答提示词" }],
    settings: { apiKey: "sk-sample-backup-secret", featureModels: { verdict: "sample-fast-model" } },
    apiKey: "sk-sample-backup-secret",
    analysisSystemPrompt: "自定义结论提示词",
  };
  const text = JSON.stringify(buildBackup(source, EXPORTED_AT));
  assert.doesNotMatch(text, /sk-sample-backup-secret|apiKey/);
  assert.doesNotMatch(text, /featureModels|sample-fast-model/);
  assert.doesNotMatch(text, /自定义问答提示词|自定义结论提示词|settings/);
});

test("新备份带简幕自己的格式标识和版本，三类记录各一个列表", () => {
  const backup = buildBackup({ notes: [NOTE], overviews: [OVERVIEW], qa: [QA] }, EXPORTED_AT);
  assert.equal(backup.kind, "jianmu-backup");
  assert.equal(BACKUP_KIND, "jianmu-backup");
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.exportedAt, "2026-11-01T08:00:00.000Z");
  assert.deepEqual(Object.keys(backup), ["kind", "version", "exportedAt", "notes", "overviews", "qa"]);
  assert.deepEqual(read(backup), {
    format: "jianmu",
    contents: { notes: [NOTE], overviews: [OVERVIEW], qa: [QA] },
    skipped: { notes: 0, overviews: 0, qa: 0 },
    promptsDropped: false,
  });
  assert.equal(buildBackup({}, Number.NaN).exportedAt, "");
});

test("新格式版本更高的报来自更新的版本，版本号读不懂的报认不出", () => {
  const backup = buildBackup({ notes: [NOTE] }, EXPORTED_AT);
  assert.deepEqual(readBackup({ ...backup, version: BACKUP_VERSION + 1 }), { ok: false, code: "BACKUP_TOO_NEW" });
  for (const version of [undefined, 0, "1", 1.5]) {
    assert.deepEqual(readBackup({ ...backup, version }), { ok: false, code: "BACKUP_UNRECOGNIZED" }, String(version));
  }
});

test("新格式的坏记录逐条跳过并计数，该是列表的不是列表才整份拒绝", () => {
  const backup = buildBackup({ notes: [NOTE], overviews: [OVERVIEW], qa: [QA] }, EXPORTED_AT);
  const imported = read({
    ...backup,
    notes: [NOTE, { ...NOTE, id: { $oid: "x" } }, { ...NOTE, id: "note_b", video: "bilibili:BV1:p1" }, { ...NOTE, id: "note_c", kind: "word" }, null],
    overviews: [OVERVIEW, { ...OVERVIEW, videoKey: "youtube:" }, { ...OVERVIEW, analysis: "不是对象" }],
    qa: [QA, { ...QA, id: "note_1" }, { ...QA, id: "qa_b", answer: 42 }],
  });
  assert.deepEqual(imported.skipped, { notes: 4, overviews: 2, qa: 2 });
  assert.deepEqual(imported.contents, { notes: [NOTE], overviews: [OVERVIEW], qa: [QA] });
  assert.deepEqual(read({ kind: BACKUP_KIND, version: 1 }).contents, { notes: [], overviews: [], qa: [] }, "缺的列表按空的算");
  for (const kind of ["notes", "overviews", "qa"] as const) {
    assert.deepEqual(readBackup({ ...backup, [kind]: { 0: NOTE } }), { ok: false, code: "BACKUP_DAMAGED", detail: kind });
  }
});

test("新格式的记录只留认得的字段：依据读不懂的记成未知，正文截到 3000 字，概览过一遍生成时的校验", () => {
  const imported = read(
    buildBackup(
      {
        notes: [
          { ...NOTE, id: "note_long", text: "长".repeat(3100), derived: { basis: { source: "transcript" } } as unknown as Derived },
          { ...NOTE, id: "note_no_gen", derived: { basis: DERIVED.basis } as unknown as Derived },
          { ...NOTE, id: "note_legacy", origin: "legacy", derived: { basis: { source: "legacy-unknown", hint: "official-summary" } } },
        ],
        overviews: [
          {
            ...OVERVIEW,
            draft: { chapters: [] },
            analysis: {
              chapters: [{ title: "越界", timestampSeconds: -1 }, { title: "  留下  ", timestampSeconds: 5 }],
              verdict: { summary: "", verdict: "值得看完整视频" },
            },
          } as OverviewRecord,
        ],
      },
      EXPORTED_AT,
    ),
  );
  const [long, noGen, legacy] = imported.contents.notes;
  assert.equal(long?.text.length, 3000);
  assert.deepEqual(long?.derived, { basis: { source: "legacy-unknown" } });
  assert.deepEqual(noGen?.derived, { basis: { source: "legacy-unknown" } }, "依据已知却缺生成配置的只能算未知");
  assert.deepEqual(legacy?.derived, { basis: { source: "legacy-unknown", hint: "official-summary" } });
  const [overview] = imported.contents.overviews;
  assert.equal(Object.hasOwn(overview ?? {}, "draft"), false, "记录类型里没有的字段不进备份");
  assert.deepEqual(overview?.analysis, {
    chapters: [{ title: "留下", summary: "", timestampSeconds: 5, timestamp: "0:05" }],
    keyQuotes: [],
  });
});
