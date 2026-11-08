// 错误码汇总：每个领域的码都有一句话的文案，领域之间不重名，结果的形状统一。
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, fail, isErrorCode, ok } from "../../../src/core/errors.ts";
import { AI_ERROR_TEXT } from "../../../src/core/errors/ai.ts";
import { ROUTING_ERROR_TEXT } from "../../../src/core/errors/routing.ts";
import { SESSION_ERROR_TEXT } from "../../../src/core/errors/session.ts";
import { SETTINGS_ERROR_CODES, SETTINGS_ERROR_TEXT } from "../../../src/core/errors/settings.ts";
import { SITE_ERROR_TEXT } from "../../../src/core/errors/site.ts";
import { TASK_ERROR_TEXT } from "../../../src/core/errors/tasks.ts";

const DOMAINS = { site: SITE_ERROR_TEXT, settings: SETTINGS_ERROR_TEXT, routing: ROUTING_ERROR_TEXT, ai: AI_ERROR_TEXT, tasks: TASK_ERROR_TEXT, session: SESSION_ERROR_TEXT };

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
