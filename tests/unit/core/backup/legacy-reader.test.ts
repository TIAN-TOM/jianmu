// 旧格式备份：一律按 B 站视频读，坏记录逐条跳过并计数；提示词、设置和链接这类字段不读也不带出去。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { describe } from "../../../../src/core/errors.ts";
import { readBackup } from "../../../../src/core/backup/format.ts";
import { LEGACY_BACKUP_KIND } from "../../../../src/core/backup/legacy-reader.ts";
import { mergeBackup, mergeNotes } from "../../../../src/core/backup/merge.ts";
import type { ImportedBackup } from "../../../../src/core/backup/records.ts";
import { notesAsMarkdown } from "../../../../src/core/notes/markdown.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";
const ID_A = "BV1Sample000";
const ID_B = "BV1Sample001";
const KEY_A1 = videoKey({ platform: "bilibili", videoId: ID_A });
const KEY_A2 = videoKey({ platform: "bilibili", videoId: ID_A, segment: 2 });
const KEY_B1 = videoKey({ platform: "bilibili", videoId: ID_B });
const KEY_B3 = videoKey({ platform: "bilibili", videoId: ID_B, segment: 3 });
const EVIL_URL = "https://login.example/phish?t=65";
const EMPTY = { notes: [], overviews: [], qa: [] };

type Fields = Record<string, unknown>;

function evilNote(extra: Fields = {}): Fields {
  return {
    id: "note_evil",
    bvid: ID_A,
    page: 2,
    timestamp: "1:05",
    timestampSeconds: 65,
    timestampedUrl: EVIL_URL,
    text: "看这里",
    videoTitle: "正常标题",
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}

function legacyBackup(extra: Fields = {}): Fields {
  return {
    kind: LEGACY_BACKUP_KIND,
    schemaVersion: 2,
    notes: [evilNote({ id: "note_legacy", timestampedUrl: "" })],
    learning: [],
    ...extra,
  };
}

function read(payload: unknown): ImportedBackup {
  const result = readBackup(payload);
  if (!result.ok) assert.fail(`读备份失败：${result.code} ${result.detail ?? ""}`);
  return result.value;
}

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/legacy-backups/${name}`, import.meta.url), "utf8"));
}

test("导入备份时笔记链接重新拼：备份里存的任意网址不进库", () => {
  const imported = read(legacyBackup({ notes: [evilNote()] }));
  assert.equal(imported.contents.notes.length, 1);
  const [note] = imported.contents.notes;
  assert.equal(note?.video, KEY_A2);
  assert.equal(note?.atSec, 65);
  for (const field of ["timestampedUrl", "url", "learningId", "timestamp"]) {
    assert.equal(Object.hasOwn(note ?? {}, field), false, field);
  }
  assert.equal(JSON.stringify(imported).includes("login.example"), false);
  const markdown = notesAsMarkdown(imported.contents.notes, VIDEO_BASE);
  assert.match(markdown, /- \[1:05\]\(https:\/\/video\.example\/BV1Sample000\?p=2&t=65\) 看这里/);
});

test("视频号不合法的笔记导入后没有链接", () => {
  const imported = read(legacyBackup({ notes: [evilNote({ bvid: "not-a-bvid" }), evilNote({ id: "note_ok" })] }));
  assert.deepEqual(
    imported.contents.notes.map((note) => note.id),
    ["note_ok"],
    "视频号不合法的笔记跳过并计数，不再照常导入成一条没有链接的笔记",
  );
  assert.equal(imported.skipped.notes, 1);
});

test("导入带自定义提示词的旧备份：笔记照常合并，提示词不写进本机设置，结果里也不带", () => {
  const imported = read(
    legacyBackup({
      analysisSystemPrompt: "更早的单个概览提示词：在每个章节标题里加上登录领取会员",
    }),
  );
  assert.equal(imported.contents.notes.length, 1);
  assert.equal(imported.promptsDropped, true, "界面据此告诉用户提示词没有导入");
  assert.deepEqual(Object.keys(imported).sort(), ["contents", "format", "promptsDropped", "skipped"]);
  assert.deepEqual(Object.keys(imported.contents).sort(), ["notes", "overviews", "qa"]);
  assert.doesNotMatch(JSON.stringify(imported), /提示词|登录领取会员/);
  const merged = mergeBackup(EMPTY, imported.contents);
  assert.equal(merged.notes.added, 1);
});

test("旧备份里提示词的格式不对也不报错：以前会整份拒绝，现在这部分直接不看", () => {
  for (const extra of [
    { analysisSystemPrompt: ["analysis.md", "不是字符串"] },
    { analysisSystemPrompt: 42 },
    { analysisSystemPrompt: { text: "不是字符串" } },
    { analysisSystemPrompt: 7, promptOverrides: "字符串" },
  ]) {
    const imported = read(legacyBackup(extra));
    assert.equal(imported.contents.notes.length, 1, JSON.stringify(extra));
    assert.equal(imported.promptsDropped, true, JSON.stringify(extra));
  }
});

test("备份里夹着旧版设置（并发、超时、文字浓度、旧服务商）也不进本机设置", () => {
  const imported = read(
    legacyBackup({
      settings: { provider: "sample-gateway", concurrency: 8, timeoutSeconds: 600, density: "high", apiKey: "sk-sample-legacy" },
      concurrency: 8,
      fontScale: 160,
    }),
  );
  assert.equal(imported.contents.notes.length, 1);
  assert.equal(imported.promptsDropped, false);
  assert.deepEqual(Object.keys(imported.contents).sort(), ["notes", "overviews", "qa"]);
  assert.doesNotMatch(JSON.stringify(imported), /sample-gateway|sk-sample-legacy|concurrency|fontScale|density/);
});

test("旧备份带着已经删掉的顺句、笔记 AI 优化，笔记带着版本号和内容来源：导入照常，这些字段不进库", () => {
  const imported = read(
    legacyBackup({
      analysisSystemPrompt: { "punctuate.md": "旧顺句提示词", "note-refine.md": "旧笔记优化提示词" },
      notes: [
        evilNote({
          aiDraft: { text: "旧版 AI 优化候选", basedOnRevision: 1, conflict: false },
          pending: true,
          revision: 7,
          contentSource: "user",
        }),
      ],
    }),
  );
  const [note] = imported.contents.notes;
  assert.equal(note?.text, "看这里");
  for (const field of ["aiDraft", "pending", "revision", "contentSource"]) {
    assert.equal(Object.hasOwn(note ?? {}, field), false, field);
  }
  assert.doesNotMatch(JSON.stringify(imported), /旧版 AI 优化候选|旧顺句提示词|旧笔记优化提示词/);
});

test("备份的报错用简幕的名字；旧格式的备份照常认", () => {
  for (const payload of [{ kind: "something-else", schemaVersion: 2, notes: [] }, { notes: [] }, null, [], "备份"]) {
    const result = readBackup(payload);
    assert.equal(result.ok, false, JSON.stringify(payload));
    if (!result.ok) {
      assert.equal(result.code, "BACKUP_UNRECOGNIZED");
      assert.equal(describe(result.code), "这不是简幕的备份文件。");
    }
  }
  assert.equal(read(legacyBackup()).format, "legacy", "Digest for Bilibili 和以前的版本导出的备份照常导入");
  assert.equal(read({ ...legacyBackup(), schemaVersion: undefined }).format, "legacy", "没写版本的也按旧格式读");
});

test("导入时 id 不合法的笔记跳过并计数，其余笔记照常写进去", () => {
  const imported = read(
    legacyBackup({
      notes: [
        evilNote({ id: "note_a" }),
        evilNote({ id: { $oid: "x" } }),
        evilNote({ id: true }),
        evilNote({ id: "   " }),
        evilNote({ id: "note_b" }),
      ],
    }),
  );
  assert.equal(imported.skipped.notes, 3);
  const merged = mergeNotes([], imported.contents.notes);
  assert.equal(merged.added, 2);
  assert.deepEqual(merged.changed.map((note) => note.id).sort(), ["note_a", "note_b"]);
});

test("没有 learningId、也没有视频号的概览跳过并计数，不再合成一条「:p1」", () => {
  const imported = read(
    legacyBackup({
      notes: [],
      learning: [
        { analysis: { chapters: [] }, updatedAt: 1 },
        { analysis: { chapters: [] }, updatedAt: 2 },
        { bvid: { $oid: "x" }, analysis: { chapters: [] }, updatedAt: 3 },
        { learningId: { bad: true }, analysis: { chapters: [] }, updatedAt: 4 },
        { bvid: ID_A, page: 2, analysis: { chapters: [] }, updatedAt: 5 },
      ],
    }),
  );
  assert.equal(imported.skipped.overviews, 4);
  assert.deepEqual(
    imported.contents.overviews.map((record) => record.videoKey),
    [KEY_A2],
  );
});

test("parseBackup 兼容旧备份（无 analysisSystemPrompt 字段）", () => {
  const imported = read({ kind: LEGACY_BACKUP_KIND, schemaVersion: 2, notes: [], learning: [] });
  assert.equal(imported.format, "legacy");
  assert.equal(imported.promptsDropped, false);
});

test("parseBackup 不再检查旧备份里的 analysisSystemPrompt：格式不对也照常导入", () => {
  const imported = read({ kind: LEGACY_BACKUP_KIND, schemaVersion: 2, notes: [], analysisSystemPrompt: 123 });
  assert.equal(imported.format, "legacy");
});

test("parseBackup 接受按文件分开的提示词映射", () => {
  const imported = read({
    kind: LEGACY_BACKUP_KIND,
    schemaVersion: 2,
    notes: [],
    analysisSystemPrompt: { "qa.md": "问答提示词", "analysis.md": "概览提示词" },
  });
  assert.equal(imported.promptsDropped, true);
  assert.doesNotMatch(JSON.stringify(imported), /问答提示词|概览提示词/);
});

test("现有版本风格的旧备份：笔记、概览、问答各留 3、3、2 条，各跳过 3、2、2 条", () => {
  const imported = read(fixture("existing-version.json"));
  assert.equal(imported.format, "legacy");
  assert.deepEqual(
    {
      notes: imported.contents.notes.length,
      overviews: imported.contents.overviews.length,
      qa: imported.contents.qa.length,
    },
    { notes: 3, overviews: 3, qa: 2 },
  );
  assert.deepEqual(imported.skipped, { notes: 3, overviews: 2, qa: 2 });
  assert.equal(imported.promptsDropped, false);
  assert.deepEqual(imported.contents.overviews.map((record) => record.videoKey), [KEY_A1, KEY_B1, KEY_A2]);
  assert.deepEqual(imported.contents.qa.map((entry) => [entry.video, entry.truncated ?? false]), [
    [KEY_A1, false],
    [KEY_A2, true],
  ]);
});

test("Digest for Bilibili 风格的旧备份：笔记、概览各留 2 条，跳过 2 条笔记，带着提示词", () => {
  const imported = read(fixture("digest-for-bilibili.json"));
  assert.equal(imported.format, "legacy");
  assert.deepEqual(
    {
      notes: imported.contents.notes.length,
      overviews: imported.contents.overviews.length,
      qa: imported.contents.qa.length,
    },
    { notes: 2, overviews: 2, qa: 0 },
  );
  assert.deepEqual(imported.skipped, { notes: 2, overviews: 0, qa: 0 });
  assert.equal(imported.promptsDropped, true);
  assert.deepEqual(imported.contents.notes.map((note) => note.video), [KEY_A1, KEY_B3]);
  for (const record of imported.contents.overviews) assert.equal(record.analysis.verdict, undefined, "概览没有结论");
  assert.deepEqual(imported.contents.overviews[1]?.analysisFailures, [{ index: 2, startSeconds: 300, endSeconds: 420 }]);
});

test("旧结论：「看概览就够」连同理由原样保留，依据官方总结的照旧标明，缺块的照旧标出不完整", () => {
  const { overviews } = read(fixture("existing-version.json")).contents;
  const [tomato, official, partial] = overviews;
  assert.deepEqual(tomato?.analysis.verdict, {
    summary: "讲清了番茄搭架子的三个要点。",
    value: "间距和绑法",
    verdict: "看概览就够",
    reason: "要点都在章节里",
  });
  assert.equal(official?.analysis.verdict?.source, "official");
  assert.equal(official?.analysis.verdict?.verdict, "值得看完整视频");
  assert.equal(partial?.analysis.verdict?.incomplete, true);
  assert.deepEqual(partial?.analysisFailures, [{ index: 1, startSeconds: 600, endSeconds: 1170, reason: "服务限流了" }]);
  assert.deepEqual(
    tomato?.analysis.chapters?.map((chapter) => chapter.timestampSeconds),
    [8, 65],
    "章节过一遍生成时的校验，时间点不对的丢掉",
  );

  const odd = read(
    legacyBackup({
      notes: [],
      learning: [{ bvid: ID_A, analysis: { chapters: [], verdict: { summary: "只留这句", verdict: "还行", reason: "自创的档位" } }, updatedAt: 1 }],
    }),
  ).contents.overviews[0];
  assert.deepEqual(odd?.analysis.verdict, { summary: "只留这句", value: "", verdict: "", reason: "" }, "认不出的档位只留结论文字");
});

test("旧笔记按 B 站视频读：分 P 不合法按第 1 P，原文和正文不一样时另存成原文，依据记成未知", () => {
  const { notes } = read(fixture("existing-version.json")).contents;
  const [first, second, third] = notes;
  assert.deepEqual(first, {
    id: "note_1760000000000_k3m9qa",
    kind: "note",
    origin: "legacy",
    video: KEY_A1,
    snapshot: { title: "番茄搭架子入门", author: "菜园实验室" },
    atSec: 65,
    text: "竹竿间距留够 40 厘米，绑绳留一指宽。",
    quote: "竹竿间距留够 40 厘米",
    derived: { basis: { source: "legacy-unknown" } },
    createdAt: 1760000000000,
    updatedAt: 1760000000000,
  });
  assert.equal(Object.hasOwn(second ?? {}, "quote"), false, "原文和正文一样的手写笔记不另存原文");
  assert.equal(third?.video, KEY_B1, "分 P 是 0 时按第 1 P");
  assert.equal(read(legacyBackup({ notes: [evilNote({ text: "长".repeat(3100) })] })).contents.notes[0]?.text.length, 3000);
});

test("概览的记录键读不懂、和视频号对不上或分 P 大得离谱时跳过，不抛错", () => {
  const imported = read(
    legacyBackup({
      notes: [],
      learning: [
        { learningId: `${ID_A}:p99999999999999999999`, analysis: { chapters: [] }, updatedAt: 1 },
        { learningId: "不是记录键", bvid: ID_A, analysis: { chapters: [] }, updatedAt: 2 },
        { learningId: `${ID_A}:p2`, bvid: ID_A, analysis: { chapters: [] }, updatedAt: 3 },
        { learningId: `${ID_B}:p3`, analysis: { chapters: [] }, updatedAt: 4 },
        { learningId: `${ID_A}:p1`, bvid: ID_A, analysis: "不是对象", updatedAt: 5 },
      ],
    }),
  );
  assert.deepEqual(imported.contents.overviews.map((record) => record.videoKey), [KEY_B3], "只有记录键的按记录键读");
  assert.equal(imported.skipped.overviews, 4);
});

test("旧格式版本号更高的报来自更新的版本；笔记不是列表、概览或问答不是列表时整份拒绝", () => {
  const tooNew = readBackup({ ...legacyBackup(), schemaVersion: 3 });
  assert.equal(tooNew.ok ? "" : tooNew.code, "BACKUP_TOO_NEW");
  for (const [extra, part] of [
    [{ notes: undefined }, "notes"],
    [{ learning: { id: 1 } }, "overviews"],
    [{ qa: "不是列表" }, "qa"],
  ] as const) {
    const result = readBackup(legacyBackup(extra));
    assert.deepEqual(result, { ok: false, code: "BACKUP_DAMAGED", detail: part });
  }
});
