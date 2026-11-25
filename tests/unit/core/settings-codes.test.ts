// 要到设置页去改的码表：表里每个码的下一步都指向设置页，页面才给「打开设置」；没码时不算。
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorCopy } from "../../../src/core/errors.ts";
import { fixedInSettings, SETTINGS_FIX_CODES } from "../../../src/core/errors/settings-codes.ts";

test("表里的码，下一步都写着去设置页；重试就好的、没有码的不算", () => {
  for (const code of SETTINGS_FIX_CODES) assert.match(errorCopy(code).next ?? "", /设置页/, code);
  assert.equal(fixedInSettings("INVALID_AI_KEY"), true);
  assert.equal(fixedInSettings("AI_IDLE_TIMEOUT"), false);
  assert.equal(fixedInSettings(null), false);
  assert.equal(fixedInSettings(undefined), false);
});
