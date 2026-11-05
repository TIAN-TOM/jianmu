import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { filterNotes } from "../../../../src/core/notes/filter.ts";
import {
  learningAsMarkdown,
  notesAsMarkdown,
  type LearningInput,
  type NotesExportOptions,
} from "../../../../src/core/notes/markdown.ts";
import type { NoteFields, NoteList } from "../../../../src/core/notes/records.ts";
import { formatTimestamp } from "../../../../src/core/transcript/segment.ts";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly result: unknown;
}

// 样本入参里的笔记，字段名和记录类型不同。
interface SampleNote {
  readonly videoKey?: string;
  readonly videoTitle?: string;
  readonly ownerName?: string;
  readonly timestamp?: string;
  readonly timestampSeconds?: number | null;
  readonly learningId?: string;
  readonly [other: string]: unknown;
}

interface SampleLearning {
  readonly notes?: readonly (SampleNote | null)[];
  readonly viewPoints?: unknown;
  readonly [other: string]: unknown;
}

const FIXTURE = new URL("../../../fixtures/golden/notes-markdown.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: GoldenCase[] };

// JSON 表达不了的值，样本里记成 { $undefined: true }。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$undefined" in value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
}

// 其余字段原样带上：草稿字段要留着，才验得出它进不了导出。
function toNote(sample: SampleNote | null): NoteFields | null {
  if (!sample) return null;
  const { videoKey, videoTitle, ownerName, timestamp, timestampSeconds, learningId, ...rest } = sample;
  // 记录里不存显示用的时间文字，映射之前先确认它能从秒数算回来。
  if (timestamp) assert.equal(timestamp, formatTimestamp(timestampSeconds));
  assert.equal(learningId, videoKey);
  return { ...rest, video: videoKey, atSec: timestampSeconds, snapshot: { title: videoTitle, author: ownerName } } as NoteFields;
}

const toNotes = (samples: unknown): NoteList => (samples as readonly (SampleNote | null)[]).map(toNote);

function toLearningInput(sample: unknown): LearningInput {
  const { notes, viewPoints, ...rest } = sample as SampleLearning;
  return {
    ...rest,
    ...(notes ? { notes: toNotes(notes) } : {}),
    ...(viewPoints ? { creatorChapters: viewPoints } : {}),
  } as LearningInput;
}

// 视频地址的前缀不写在测试里，从样本第一条的页面链接反推。
function videoBaseFrom(entries: readonly GoldenCase[]): string {
  const result = entries[0]?.result;
  assert.ok(typeof result === "string");
  const base = /^(\S+)BV1GoLDen001$/m.exec(result)?.[1];
  assert.ok(base);
  return base;
}

const VIDEO_BASE = videoBaseFrom(cases);

const FUNCTIONS: Readonly<Record<string, (args: unknown[]) => unknown>> = {
  filterNotes: ([notes, query]) => filterNotes(toNotes(notes), query as string),
  learningAsMarkdown: ([input]) => learningAsMarkdown(toLearningInput(input), VIDEO_BASE),
  notesAsMarkdown: ([notes, options]) => notesAsMarkdown(toNotes(notes), VIDEO_BASE, options as NotesExportOptions),
};

// 过滤原样返回笔记，结果也要换成记录的字段才比得上。
function expected(entry: GoldenCase): unknown {
  const result = decode(entry.result);
  return entry.fn === "filterNotes" ? toNotes(result) : result;
}

test("样本覆盖全部用例和函数", () => {
  assert.equal(cases.length, 24);
  assert.deepEqual([...new Set(cases.map((entry) => entry.fn))].sort(), Object.keys(FUNCTIONS).sort());
});

test("有内容的学习稿都写了不带引号的视频键，没有拆开的身份字段", () => {
  const drafts = cases.filter((entry) => entry.fn === "learningAsMarkdown" && entry.result !== "");
  assert.equal(drafts.length, 10);
  for (const entry of drafts) {
    assert.match(String(entry.result), /^videoKey: bilibili:BV1GoLDen001:p[12]$/m, entry.id);
    assert.doesNotMatch(String(entry.result), /^page: /m, entry.id);
  }
});

for (const entry of cases) {
  test(`黄金样本 ${entry.id} ${entry.label}`.trim(), () => {
    const run = FUNCTIONS[entry.fn];
    assert.ok(run, `样本里有没接上的函数：${entry.fn}`);
    assert.deepEqual(run(decode(entry.args) as unknown[]), expected(entry));
  });
}
