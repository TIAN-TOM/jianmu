import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hasOfficialContent, isOfficialDone, officialTodo, verdictTodo } from "../../../../src/core/triage/batch.ts";
import {
  formatDateTime,
  formatDuration,
  officialStatusText,
  progressText,
  toMarkdown,
  verdictSourceText,
  videoUrl,
} from "../../../../src/core/triage/export.ts";
import { groupItems, groupKeyOf, hasVerdict } from "../../../../src/core/triage/groups.ts";
import { normalizeState } from "../../../../src/core/triage/state.ts";

// 样本的日期按 UTC 录。测试文件各占一个进程，改时区不影响别的文件。
process.env.TZ = "UTC";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly result: unknown;
}

const FIXTURE = new URL("../../../fixtures/golden/triage.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: GoldenCase[] };

// JSON 表达不了的值，样本里记成 { $undefined: true }、{ $number: "NaN" }。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$undefined" in value) return undefined;
  if ("$number" in value) return Number(value.$number);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
}

// 视频地址的前缀不写在测试里，从样本里那一条反推。
function videoBaseFrom(entries: readonly GoldenCase[]): string {
  const entry = entries.find((candidate) => candidate.fn === "videoUrl");
  assert.ok(entry);
  const [id] = entry.args;
  assert.ok(typeof id === "string" && typeof entry.result === "string");
  assert.ok(entry.result.endsWith(id));
  return entry.result.slice(0, -id.length);
}

const VIDEO_BASE = videoBaseFrom(cases);

const plain =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (args: unknown[]): R =>
    fn(...(args as A));

const withBase =
  <First, R>(fn: (first: First, baseUrl: string) => R) =>
  (args: unknown[]): R =>
    fn(args[0] as First, VIDEO_BASE);

const FUNCTIONS: Readonly<Record<string, (args: unknown[]) => unknown>> = {
  formatDateTime: plain(formatDateTime),
  formatDuration: plain(formatDuration),
  groupItems: plain(groupItems),
  groupKeyOf: plain(groupKeyOf),
  hasOfficialContent: plain(hasOfficialContent),
  hasVerdict: plain(hasVerdict),
  isOfficialDone: plain(isOfficialDone),
  normalizeState: plain(normalizeState),
  officialStatusText: plain(officialStatusText),
  officialTodo: plain(officialTodo),
  progressText: plain(progressText),
  toMarkdown: withBase(toMarkdown),
  verdictSourceText: plain(verdictSourceText),
  verdictTodo: plain(verdictTodo),
  videoUrl: withBase(videoUrl),
};

test("样本覆盖全部用例和函数", () => {
  assert.equal(cases.length, 60);
  assert.deepEqual([...new Set(cases.map((entry) => entry.fn))].sort(), Object.keys(FUNCTIONS).sort());
});

for (const entry of cases) {
  test(`黄金样本 ${entry.id} ${entry.label}`.trim(), () => {
    const run = FUNCTIONS[entry.fn];
    assert.ok(run, `样本里有没接上的函数：${entry.fn}`);
    assert.deepEqual(run(decode(entry.args) as unknown[]), decode(entry.result));
  });
}
