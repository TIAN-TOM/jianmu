// 设置页表单的纯逻辑：换服务商时密钥只跟着它所属的来源走，按功能选的模型换了归属就清空；
// 拼出的保存设置写明密钥来源和模型归属，规整以后密钥不会落到别家的地址上。
import assert from "node:assert/strict";
import { test } from "node:test";
import { formOf, settingsInput, showsRegionChooser, withAddress, withPreset } from "../../../../src/pages/options/form.ts";
import type { LoadedSettings } from "../../../../src/platform/settings-store.ts";
import { DEFAULTS, featureModelsOwnerOf, normalize } from "../../../../src/shared/settings-schema.ts";

function savedWith(input: Record<string, unknown>): LoadedSettings {
  return { ...normalize({ ...DEFAULTS, ...input }), settingsRevision: "r1" };
}

const DEEPSEEK = savedWith({ presetId: "deepseek", aiApiKey: "sk-deep", featureModels: { qa: "deepseek-reasoner" } });

test("换到别家服务商：密钥和按功能选的模型清空，换回来时已存的密钥填回去", () => {
  const form = formOf(DEEPSEEK);
  assert.equal(form.aiApiKey, "sk-deep");
  const moved = withPreset(form, "openai", DEEPSEEK);
  assert.equal(moved.aiApiKey, "");
  assert.deepEqual(moved.featureModels, {});
  assert.equal(moved.aiBaseUrl, "https://api.openai.com/v1");
  const back = withPreset(moved, "deepseek", DEEPSEEK);
  assert.equal(back.aiApiKey, "sk-deep");
  assert.equal(back.aiModel, DEEPSEEK.aiModel);
});

test("自定义地址换了域名，密钥清空；同一域名换路径不动", () => {
  const custom = savedWith({ presetId: "custom", protocol: "openai", aiBaseUrl: "https://gateway.example.com/v1", aiApiKey: "sk-gw" });
  const form = formOf(custom);
  assert.equal(withAddress(form, { aiBaseUrl: "https://gateway.example.com/v2" }, custom).aiApiKey, "sk-gw");
  assert.equal(withAddress(form, { aiBaseUrl: "https://other.example.org/v1" }, custom).aiApiKey, "");
});

test("新填的密钥归到表单当前的地址；没动过的密钥按已存的来源，规整后留在原来的服务商", () => {
  const typed = { ...withPreset(formOf(DEEPSEEK), "openai", DEEPSEEK), aiApiKey: "sk-open", keyTyped: true };
  const input = settingsInput(typed, DEEPSEEK);
  assert.equal(input.aiApiKeyOrigin, "https://api.openai.com/");
  assert.equal(normalize(input).aiApiKey, "sk-open");

  const untouched = settingsInput(formOf(DEEPSEEK), DEEPSEEK);
  assert.equal(untouched.aiApiKeyOrigin, "");
  assert.equal(untouched.featureModelsOwner, featureModelsOwnerOf(DEEPSEEK));
  assert.deepEqual(normalize({ ...untouched, aiApiKeyOrigin: DEEPSEEK.aiApiKeyOrigin }).featureModels, { qa: "deepseek-reasoner" });
});

test("快捷选择只给还没填密钥、停在快捷预设上、没另选模型的人", () => {
  assert.equal(showsRegionChooser(savedWith({})), true);
  assert.equal(showsRegionChooser(DEEPSEEK), false);
  assert.equal(showsRegionChooser(savedWith({ presetId: "openai" })), false);
  assert.equal(showsRegionChooser(savedWith({ featureModels: { qa: "x" } })), false);
});
