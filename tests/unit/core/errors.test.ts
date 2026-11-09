// 错误码汇总：每个领域的码都有一句话的文案，领域之间不重名，结果的形状统一。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, fail, isErrorCode, ok } from "../../../src/core/errors.ts";
import { AI_ERROR_TEXT } from "../../../src/core/errors/ai.ts";
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
};

test("每个码都有一句给用户看的话，各领域之间不重名", () => {
  const seen = new Map<string, string>();
  for (const [domain, table] of Object.entries(DOMAINS)) {
    for (const [code, text] of Object.entries(table)) {
      assert.equal(seen.has(code), false, `${code} 在 ${seen.get(code)} 和 ${domain} 里都有`);
      seen.set(code, domain);
      assert.ok(isErrorCode(code), code);
      assert.equal(describe(code as never), text);
      assert.match(text, /[。]$/, `${code} 是一句完整的话`);
    }
  }
});

test("按说明换说法的只有认得的那几个，说明对不上时用码本身的说法", () => {
  for (const [detail, text] of Object.entries(SITE_DETAIL_TEXT.UNPLAYABLE ?? {})) {
    assert.equal(describe("UNPLAYABLE", detail), text);
    assert.notEqual(text, SITE_ERROR_TEXT.UNPLAYABLE);
  }
  assert.equal(describe("UNPLAYABLE", "toString"), SITE_ERROR_TEXT.UNPLAYABLE, "原型上的名字不算");
  assert.equal(describe("UNPLAYABLE", ""), SITE_ERROR_TEXT.UNPLAYABLE);
});

test("字幕文件读不了时按原因换说法，和解析时给的说法一致", () => {
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
    assert.equal(describe("UNSUPPORTED_FILE", detail), parsed.message, detail);
  }
  assert.equal(describe("UNSUPPORTED_FILE"), TRANSCRIPT_ERROR_TEXT.UNSUPPORTED_FILE);
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
