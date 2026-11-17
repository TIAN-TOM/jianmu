// 错误码汇总：每个领域的码都有原因、影响、下一步三段文案，领域之间不重名，结果的形状统一。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { describe, errorCopy, fail, isErrorCode, ok, type ErrorCode, type ErrorCopy } from "../../../src/core/errors.ts";
import { AI_ERROR_TEXT } from "../../../src/core/errors/ai.ts";
import { BACKUP_ERROR_TEXT } from "../../../src/core/errors/backup.ts";
import { BATCH_ERROR_TEXT } from "../../../src/core/errors/batch.ts";
import { DATA_ERROR_TEXT } from "../../../src/core/errors/data.ts";
import { NOTE_ERROR_TEXT } from "../../../src/core/errors/notes.ts";
import { OVERVIEW_ERROR_TEXT } from "../../../src/core/errors/overview.ts";
import { QA_ERROR_TEXT } from "../../../src/core/errors/qa.ts";
import { ROUTING_ERROR_TEXT } from "../../../src/core/errors/routing.ts";
import { SESSION_ERROR_TEXT } from "../../../src/core/errors/session.ts";
import { SETTINGS_ERROR_CODES, SETTINGS_ERROR_TEXT } from "../../../src/core/errors/settings.ts";
import { SITE_DETAIL_TEXT, SITE_ERROR_TEXT } from "../../../src/core/errors/site.ts";
import { TASK_ERROR_TEXT } from "../../../src/core/errors/tasks.ts";
import { TRANSCRIPT_DETAIL_TEXT, TRANSCRIPT_ERROR_TEXT } from "../../../src/core/errors/transcript.ts";
import { TRANSLATE_ERROR_TEXT } from "../../../src/core/errors/translate.ts";
import { parseSubtitleFile } from "../../../src/core/transcript/import-file.ts";

const DOMAINS = {
  site: SITE_ERROR_TEXT,
  settings: SETTINGS_ERROR_TEXT,
  routing: ROUTING_ERROR_TEXT,
  ai: AI_ERROR_TEXT,
  tasks: TASK_ERROR_TEXT,
  session: SESSION_ERROR_TEXT,
  transcript: TRANSCRIPT_ERROR_TEXT,
  data: DATA_ERROR_TEXT,
  overview: OVERVIEW_ERROR_TEXT,
  qa: QA_ERROR_TEXT,
  notes: NOTE_ERROR_TEXT,
  translate: TRANSLATE_ERROR_TEXT,
  backup: BACKUP_ERROR_TEXT,
  batch: BATCH_ERROR_TEXT,
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 每个码的文案，连同按 detail 换的说法。 */
function allCopies(): { readonly label: string; readonly copy: ErrorCopy }[] {
  const out: { label: string; copy: ErrorCopy }[] = [];
  for (const table of Object.values(DOMAINS)) for (const [code, copy] of Object.entries(table)) out.push({ label: code, copy });
  for (const tables of [SITE_DETAIL_TEXT, TRANSCRIPT_DETAIL_TEXT]) {
    for (const [code, byDetail] of Object.entries(tables)) for (const [detail, copy] of Object.entries(byDetail ?? {})) out.push({ label: `${code}/${detail}`, copy });
  }
  return out;
}

const partsOf = (copy: ErrorCopy) => [copy.cause, copy.impact, copy.next].filter((part) => part !== undefined);

test("每个码都有原因，各领域之间不重名", () => {
  const seen = new Map<string, string>();
  for (const [domain, table] of Object.entries(DOMAINS)) {
    for (const [code, copy] of Object.entries(table)) {
      assert.equal(seen.has(code), false, `${code} 在 ${seen.get(code)} 和 ${domain} 里都有`);
      seen.set(code, domain);
      assert.ok(isErrorCode(code), code);
      assert.equal(errorCopy(code as ErrorCode), copy);
    }
  }
});

test("每一段都是以句号结尾的整句，没有空段", () => {
  for (const { label, copy } of allCopies()) {
    assert.ok(copy.cause.trim(), `${label} 没有原因`);
    for (const part of partsOf(copy)) assert.match(part, /^\S.*。$/s, `${label}：「${part}」不是一句完整的话`);
  }
});

test("一段话的说法是三段按原因、影响、下一步连起来", () => {
  for (const code of Object.values(DOMAINS).flatMap((table) => Object.keys(table)) as ErrorCode[]) {
    assert.equal(describe(code), partsOf(errorCopy(code)).join(""), code);
  }
  assert.equal(describe("UNPLAYABLE", "paid"), partsOf(SITE_DETAIL_TEXT.UNPLAYABLE?.paid as ErrorCopy).join(""));
});

test("费用只说可能计费或没发请求，不承诺免费或不计费", () => {
  for (const { label, copy } of allCopies()) {
    for (const part of partsOf(copy)) assert.doesNotMatch(part, /免费|不计费|不会计费|不收费|联系管理员/, `${label}：${part}`);
  }
});

/** 页面和共用代码的源码，去掉「」引起来的说明文字，只留真正的标签和标题。 */
function pageSources(): string {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of ["src/pages", "src/content", "src/shared"]) walk(join(ROOT, dir));
  return files.map((file) => readFileSync(file, "utf8").replace(/「[^」]*」/g, "")).join("\n");
}

test("下一步里点名的按钮和选项在页面上确实有", () => {
  const sources = pageSources();
  for (const { label, copy } of allCopies()) {
    for (const [, name] of (copy.next ?? "").matchAll(/「([^」]+)」/g)) {
      assert.ok(sources.includes(name as string), `${label} 让用户点「${name}」，页面上没有这个标签`);
    }
  }
});

test("下一步里说的页面确实有", () => {
  const PLACES: Readonly<Record<string, string>> = {
    设置页: "src/pages/options/app.tsx",
    侧边栏: "src/pages/sidepanel/app.tsx",
    字幕页签: "src/pages/sidepanel/transcript-tab.tsx",
  };
  for (const { label, copy } of allCopies()) {
    for (const [place, file] of Object.entries(PLACES)) {
      if ((copy.next ?? "").includes(place)) assert.ok(existsSync(join(ROOT, file)), `${label} 提到${place}，${file} 不在`);
    }
  }
});

test("按说明换说法的只有认得的那几个，说明对不上时用码本身的说法", () => {
  for (const [detail, copy] of Object.entries(SITE_DETAIL_TEXT.UNPLAYABLE ?? {})) {
    assert.equal(errorCopy("UNPLAYABLE", detail), copy);
    assert.notEqual(copy.cause, SITE_ERROR_TEXT.UNPLAYABLE.cause);
  }
  assert.equal(errorCopy("UNPLAYABLE", "toString"), SITE_ERROR_TEXT.UNPLAYABLE, "原型上的名字不算");
  assert.equal(errorCopy("UNPLAYABLE", ""), SITE_ERROR_TEXT.UNPLAYABLE);
});

test("字幕文件读不了时按原因换说法，原因一段和解析时给的说法一致", () => {
  const samples: Readonly<Record<string, string>> = {
    EMPTY_FILE: "",
    FILE_TOO_LARGE: "x".repeat(2 * 1024 * 1024 + 1),
    TOO_MANY_ENTRIES: Array.from({ length: 20001 }, (_, index) => `00:00:${String(index % 60).padStart(2, "0")},000 --> 00:01:00,000\n句${index}\n`).join("\n"),
    NO_CUES: "这不是字幕",
  };
  const details = TRANSCRIPT_DETAIL_TEXT.UNSUPPORTED_FILE ?? {};
  assert.deepEqual(Object.keys(details).sort(), Object.keys(samples).sort());
  for (const [detail, text] of Object.entries(samples)) {
    const parsed = parseSubtitleFile(text, "a.srt");
    assert.equal(parsed.ok, false, detail);
    if (parsed.ok) continue;
    assert.equal(parsed.error, detail);
    assert.equal(errorCopy("UNSUPPORTED_FILE", detail).cause, parsed.message, detail);
  }
  assert.equal(errorCopy("UNSUPPORTED_FILE"), TRANSCRIPT_ERROR_TEXT.UNSUPPORTED_FILE);
});

test("认不出的码不算，原型上的名字也不算", () => {
  for (const value of ["NOT_A_CODE", "toString", "", null, 1]) assert.equal(isErrorCode(value), false, String(value));
});

test("设置的码表和文案一致，搬家前后的三个码都在", () => {
  assert.deepEqual([...SETTINGS_ERROR_CODES].sort(), ["REMEMBER_KEY_UNBOUND", "REMEMBER_KEY_UNPROTECTED", "SETTINGS_STALE"]);
});

test("成功和失败的结果形状", () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, value: { a: 1 } });
  assert.deepEqual(fail("FORBIDDEN"), { ok: false, code: "FORBIDDEN" });
  assert.deepEqual(fail("UNPLAYABLE", "detail"), { ok: false, code: "UNPLAYABLE", detail: "detail" });
});
