// 报错文案的英文、繁体那份：每个码、每个按 detail 换的说法都有英文和繁体，段落和简体一一对应；不传语言、传中文和原来逐字一样。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, errorCopy, isErrorCode, type ErrorCode, type ErrorCopy } from "../../../src/core/errors.ts";
import { AI_ERROR_TEXT, AI_ERROR_TEXT_EN } from "../../../src/core/errors/ai.ts";
import { AI_ERROR_TEXT_HANT } from "../../../src/core/errors/ai-hant.ts";
import { BACKUP_ERROR_TEXT_HANT } from "../../../src/core/errors/backup-hant.ts";
import { BATCH_ERROR_TEXT_HANT } from "../../../src/core/errors/batch-hant.ts";
import { DATA_ERROR_TEXT_HANT } from "../../../src/core/errors/data-hant.ts";
import { FRAME_ERROR_TEXT_HANT } from "../../../src/core/errors/frame-hant.ts";
import { NOTE_ERROR_TEXT_HANT } from "../../../src/core/errors/notes-hant.ts";
import { OVERVIEW_ERROR_TEXT_HANT } from "../../../src/core/errors/overview-hant.ts";
import { QA_ERROR_TEXT_HANT } from "../../../src/core/errors/qa-hant.ts";
import { ROUTING_ERROR_TEXT_HANT } from "../../../src/core/errors/routing-hant.ts";
import { SESSION_ERROR_TEXT_HANT } from "../../../src/core/errors/session-hant.ts";
import { SETTINGS_ERROR_TEXT_HANT } from "../../../src/core/errors/settings-hant.ts";
import { SITE_DETAIL_TEXT_HANT, SITE_ERROR_TEXT_HANT } from "../../../src/core/errors/site-hant.ts";
import { TASK_ERROR_TEXT_HANT } from "../../../src/core/errors/tasks-hant.ts";
import { TRANSCRIPT_DETAIL_TEXT_HANT, TRANSCRIPT_ERROR_TEXT_HANT } from "../../../src/core/errors/transcript-hant.ts";
import { TRANSLATE_ERROR_TEXT_HANT } from "../../../src/core/errors/translate-hant.ts";
import { charsIn, SIMPLIFIED_ONLY } from "../../helpers/hant-chars.ts";
import { BACKUP_ERROR_TEXT, BACKUP_ERROR_TEXT_EN } from "../../../src/core/errors/backup.ts";
import { BATCH_ERROR_TEXT, BATCH_ERROR_TEXT_EN } from "../../../src/core/errors/batch.ts";
import { DATA_ERROR_TEXT, DATA_ERROR_TEXT_EN } from "../../../src/core/errors/data.ts";
import { FRAME_ERROR_TEXT, FRAME_ERROR_TEXT_EN } from "../../../src/core/errors/frame.ts";
import { NOTE_ERROR_TEXT, NOTE_ERROR_TEXT_EN } from "../../../src/core/errors/notes.ts";
import { OVERVIEW_ERROR_TEXT, OVERVIEW_ERROR_TEXT_EN } from "../../../src/core/errors/overview.ts";
import { QA_ERROR_TEXT, QA_ERROR_TEXT_EN } from "../../../src/core/errors/qa.ts";
import { ROUTING_ERROR_TEXT, ROUTING_ERROR_TEXT_EN } from "../../../src/core/errors/routing.ts";
import { SESSION_ERROR_TEXT, SESSION_ERROR_TEXT_EN } from "../../../src/core/errors/session.ts";
import { SETTINGS_ERROR_TEXT, SETTINGS_ERROR_TEXT_EN } from "../../../src/core/errors/settings.ts";
import { SITE_DETAIL_TEXT, SITE_DETAIL_TEXT_EN, SITE_ERROR_TEXT, SITE_ERROR_TEXT_EN } from "../../../src/core/errors/site.ts";
import { TASK_ERROR_TEXT, TASK_ERROR_TEXT_EN } from "../../../src/core/errors/tasks.ts";
import { TRANSCRIPT_DETAIL_TEXT, TRANSCRIPT_DETAIL_TEXT_EN, TRANSCRIPT_ERROR_TEXT, TRANSCRIPT_ERROR_TEXT_EN } from "../../../src/core/errors/transcript.ts";
import { TRANSLATE_ERROR_TEXT, TRANSLATE_ERROR_TEXT_EN } from "../../../src/core/errors/translate.ts";

type Table = Readonly<Record<string, ErrorCopy>>;

// 测试构建打开了解释当前画面，画面的码也在表里。
const PAIRS: readonly (readonly [Table, Table])[] = [
  [SITE_ERROR_TEXT, SITE_ERROR_TEXT_EN],
  [SETTINGS_ERROR_TEXT, SETTINGS_ERROR_TEXT_EN],
  [ROUTING_ERROR_TEXT, ROUTING_ERROR_TEXT_EN],
  [AI_ERROR_TEXT, AI_ERROR_TEXT_EN],
  [TASK_ERROR_TEXT, TASK_ERROR_TEXT_EN],
  [SESSION_ERROR_TEXT, SESSION_ERROR_TEXT_EN],
  [TRANSCRIPT_ERROR_TEXT, TRANSCRIPT_ERROR_TEXT_EN],
  [DATA_ERROR_TEXT, DATA_ERROR_TEXT_EN],
  [OVERVIEW_ERROR_TEXT, OVERVIEW_ERROR_TEXT_EN],
  [QA_ERROR_TEXT, QA_ERROR_TEXT_EN],
  [NOTE_ERROR_TEXT, NOTE_ERROR_TEXT_EN],
  [TRANSLATE_ERROR_TEXT, TRANSLATE_ERROR_TEXT_EN],
  [BACKUP_ERROR_TEXT, BACKUP_ERROR_TEXT_EN],
  [BATCH_ERROR_TEXT, BATCH_ERROR_TEXT_EN],
  [FRAME_ERROR_TEXT, FRAME_ERROR_TEXT_EN],
];

const DETAIL_PAIRS = [
  [SITE_DETAIL_TEXT, SITE_DETAIL_TEXT_EN],
  [TRANSCRIPT_DETAIL_TEXT, TRANSCRIPT_DETAIL_TEXT_EN],
] as unknown as readonly (readonly [Readonly<Record<string, Table>>, Readonly<Record<string, Table>>])[];

const CJK = /[　-〿一-鿿＀-￯]/;
const ALL_CODES = PAIRS.flatMap(([zh]) => Object.keys(zh)) as ErrorCode[];

/** 中英两段一一对应：有原因、影响、下一步的哪几段，英文就有哪几段。 */
function sameShape(label: string, zh: ErrorCopy, en: ErrorCopy): void {
  for (const part of ["cause", "impact", "next"] as const) {
    assert.equal(en[part] === undefined, zh[part] === undefined, `${label}.${part}：中文${zh[part] === undefined ? "没有" : "有"}这一段，英文对不上`);
    const text = en[part];
    if (text === undefined) continue;
    assert.ok(text.trim(), `${label}.${part} 是空的`);
    assert.doesNotMatch(text, CJK, `${label}.${part}：「${text}」里有中文`);
    assert.match(text, /^\S.*[.…]$/s, `${label}.${part}：「${text}」不是以句号结尾的整句`);
    assert.doesNotMatch(text, /Oops|—|Moreover|Furthermore/, `${label}.${part}：${text}`);
  }
}

test("每个码都有英文，码和中文那份一样多，段落一一对应", () => {
  for (const [zh, en] of PAIRS) {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    for (const [code, copy] of Object.entries(zh)) sameShape(code, copy, en[code] as ErrorCopy);
  }
  assert.ok(ALL_CODES.length > 90, "码都拿到了");
});

test("按 detail 换说法的英文：detail 和中文那份一样多，按语言取到对应的那份", () => {
  for (const [zh, en] of DETAIL_PAIRS) {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    for (const [code, byDetail] of Object.entries(zh)) {
      assert.deepEqual(Object.keys(en[code] ?? {}).sort(), Object.keys(byDetail).sort(), code);
      for (const [detail, copy] of Object.entries(byDetail)) {
        const english = en[code]?.[detail] as ErrorCopy;
        sameShape(`${code}/${detail}`, copy, english);
        assert.equal(errorCopy(code as ErrorCode, detail, "en"), english);
        assert.equal(errorCopy(code as ErrorCode, detail, "zh"), copy);
      }
    }
  }
  assert.equal(errorCopy("UNPLAYABLE", "toString", "en"), SITE_ERROR_TEXT_EN.UNPLAYABLE, "原型上的名字不算");
});

test("不传语言、传中文和原来一样：三段取中文那份，一段话直接连起来", () => {
  for (const [zh] of PAIRS) {
    for (const [code, copy] of Object.entries(zh)) {
      assert.ok(isErrorCode(code), code);
      assert.equal(errorCopy(code as ErrorCode), copy);
      assert.equal(errorCopy(code as ErrorCode, undefined, "zh"), copy);
      const joined = [copy.cause, copy.impact, copy.next].filter(Boolean).join("");
      assert.equal(describe(code as ErrorCode), joined);
      assert.equal(describe(code as ErrorCode, undefined, "zh"), joined);
    }
  }
});

test("英文的一段话是三段之间隔一个空格，里面没有中文", () => {
  for (const [, en] of PAIRS) {
    for (const [code, copy] of Object.entries(en)) {
      assert.equal(errorCopy(code as ErrorCode, undefined, "en"), copy);
      const text = describe(code as ErrorCode, undefined, "en");
      assert.equal(text, [copy.cause, copy.impact, copy.next].filter(Boolean).join(" "));
      assert.doesNotMatch(text, CJK, code);
    }
  }
  assert.equal(describe("UNPLAYABLE", "paid", "en"), "This is paid content. Jianmu doesn't read paid content, so nothing was read or sent to the model.");
});

test("费用的说法和中文一样谨慎：只说可能计费或没花额度，不承诺免费", () => {
  for (const [, en] of PAIRS) {
    for (const [code, copy] of Object.entries(en)) {
      for (const part of [copy.cause, copy.impact, copy.next]) {
        if (part) assert.doesNotMatch(part, /\bfree of charge\b|\bfor free\b|\bis free\b|won't be (?:billed|charged)|not be charged|contact (?:your )?administrator/i, `${code}：${part}`);
      }
    }
  }
});

test("英文里的产品名写 Jianmu，说没花额度用统一的说法", () => {
  for (const [, en] of PAIRS) {
    for (const [code, copy] of Object.entries(en)) {
      for (const part of [copy.cause, copy.impact, copy.next]) if (part) assert.doesNotMatch(part, /简幕|Jian Mu|jianmu\b/, `${code}：${part}`);
    }
  }
  assert.match(AI_ERROR_TEXT_EN.NO_AI_CONFIG.impact ?? "", /didn't use any API credit/);
});

// 繁体那份：和简体逐表对照。
const HANT_PAIRS: readonly (readonly [Table, Table])[] = [
  [SITE_ERROR_TEXT, SITE_ERROR_TEXT_HANT],
  [SETTINGS_ERROR_TEXT, SETTINGS_ERROR_TEXT_HANT],
  [ROUTING_ERROR_TEXT, ROUTING_ERROR_TEXT_HANT],
  [AI_ERROR_TEXT, AI_ERROR_TEXT_HANT],
  [TASK_ERROR_TEXT, TASK_ERROR_TEXT_HANT],
  [SESSION_ERROR_TEXT, SESSION_ERROR_TEXT_HANT],
  [TRANSCRIPT_ERROR_TEXT, TRANSCRIPT_ERROR_TEXT_HANT],
  [DATA_ERROR_TEXT, DATA_ERROR_TEXT_HANT],
  [OVERVIEW_ERROR_TEXT, OVERVIEW_ERROR_TEXT_HANT],
  [QA_ERROR_TEXT, QA_ERROR_TEXT_HANT],
  [NOTE_ERROR_TEXT, NOTE_ERROR_TEXT_HANT],
  [TRANSLATE_ERROR_TEXT, TRANSLATE_ERROR_TEXT_HANT],
  [BACKUP_ERROR_TEXT, BACKUP_ERROR_TEXT_HANT],
  [BATCH_ERROR_TEXT, BATCH_ERROR_TEXT_HANT],
  [FRAME_ERROR_TEXT, FRAME_ERROR_TEXT_HANT],
];

const HANT_DETAIL_PAIRS = [
  [SITE_DETAIL_TEXT, SITE_DETAIL_TEXT_HANT],
  [TRANSCRIPT_DETAIL_TEXT, TRANSCRIPT_DETAIL_TEXT_HANT],
] as unknown as readonly (readonly [Readonly<Record<string, Table>>, Readonly<Record<string, Table>>])[];

/** 简繁两段一一对应：每段是以句号结尾的整句，没有简体专用字，也不是原样照抄简体。 */
function sameShapeHant(label: string, zh: ErrorCopy, hant: ErrorCopy): void {
  for (const part of ["cause", "impact", "next"] as const) {
    assert.equal(hant[part] === undefined, zh[part] === undefined, `${label}.${part}：简体${zh[part] === undefined ? "没有" : "有"}这一段，繁体对不上`);
    const text = hant[part];
    if (text === undefined) continue;
    assert.match(text, /^\S.*[。…]$/s, `${label}.${part}：「${text}」不是以句号结尾的整句`);
    assert.deepEqual(charsIn(text, SIMPLIFIED_ONLY), [], `${label}.${part}：「${text}」里有简体字`);
    // 要用户照抄的来源写法（例如 chrome-extension://*）里的冒号不算标点。
    assert.doesNotMatch(text.replace(/[a-z-]+:\/\//g, ""), /[,;:?!]/, `${label}.${part}：「${text}」里有半形标点`);
    if (/[^\x00-\x7f。]/.test(zh[part] ?? "")) assert.notEqual(text, zh[part], `${label}.${part} 照抄了简体`);
  }
}

test("繁体：每个码都有繁体，码和简体那份一样多，段落一一对应，取文案时取到繁体那份", () => {
  for (const [zh, hant] of HANT_PAIRS) {
    assert.deepEqual(Object.keys(hant).sort(), Object.keys(zh).sort());
    for (const [code, copy] of Object.entries(zh)) {
      sameShapeHant(code, copy, hant[code] as ErrorCopy);
      assert.equal(errorCopy(code as ErrorCode, undefined, "zh-Hant"), hant[code]);
    }
  }
});

test("繁体：按 detail 换的说法也有繁体，按语言取到对应的那份", () => {
  for (const [zh, hant] of HANT_DETAIL_PAIRS) {
    assert.deepEqual(Object.keys(hant).sort(), Object.keys(zh).sort());
    for (const [code, byDetail] of Object.entries(zh)) {
      assert.deepEqual(Object.keys(hant[code] ?? {}).sort(), Object.keys(byDetail).sort(), code);
      for (const [detail, copy] of Object.entries(byDetail)) {
        const traditional = hant[code]?.[detail] as ErrorCopy;
        sameShapeHant(`${code}/${detail}`, copy, traditional);
        assert.equal(errorCopy(code as ErrorCode, detail, "zh-Hant"), traditional);
      }
    }
  }
  assert.equal(errorCopy("UNPLAYABLE", "toString", "zh-Hant"), SITE_ERROR_TEXT_HANT.UNPLAYABLE, "原型上的名字不算");
});

test("繁体的一段话和简体一样三段直接连写", () => {
  for (const [, hant] of HANT_PAIRS) {
    for (const [code, copy] of Object.entries(hant)) {
      assert.equal(describe(code as ErrorCode, undefined, "zh-Hant"), [copy.cause, copy.impact, copy.next].filter(Boolean).join(""));
    }
  }
  assert.equal(describe("UNPLAYABLE", "paid", "zh-Hant"), "這是付費內容。簡幕不讀取付費內容，什麼都沒讀，也沒傳給模型。");
});
