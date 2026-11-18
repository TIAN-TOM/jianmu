// 设置页表单的纯逻辑：换服务商时密钥只跟着它所属的来源走，按功能选的模型换了归属就清空；
// 拼出的保存设置写明密钥来源和模型归属，规整以后密钥不会落到别家的地址上；推理强度和概览分块不在表单里，保存时按存着的补全；
// 实际档位和选的不一样时才说。
import assert from "node:assert/strict";
import { test } from "node:test";
import { effortNoteText, formOf, serviceChanged, settingsInput, showsRegionChooser, withAddress, withPreset } from "../../../../src/pages/options/form.ts";
import type { LoadedSettings } from "../../../../src/platform/settings-store.ts";
import { DATA_CONSENT_CONFIRMED, DEFAULTS, featureModelsOwnerOf, normalize } from "../../../../src/shared/settings-schema.ts";

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

test("快捷选择只给还没填密钥、停在快捷预设上、没另选模型、也没同意过数据说明的人", () => {
  assert.equal(showsRegionChooser(savedWith({})), true);
  // 同意过说明的人配过一轮了：重启以后密钥清空，不再摆「先选一类服务」，免得点一下把服务商换掉。
  assert.equal(showsRegionChooser(savedWith({ ...DATA_CONSENT_CONFIRMED })), false);
  assert.equal(showsRegionChooser(DEEPSEEK), false);
  assert.equal(showsRegionChooser(savedWith({ presetId: "openai" })), false);
  assert.equal(showsRegionChooser(savedWith({ featureModels: { qa: "x" } })), false);
});

test("推理强度和概览分块即改即存，不在表单里：换服务商、改地址以后保存，按存着的写回", () => {
  const saved = savedWith({ ...DEEPSEEK, featureEfforts: { qa: "high", analysis: "low" }, analysisChunkMode: "short" });
  const form = formOf(saved);
  assert.equal(Object.hasOwn(form, "featureEfforts"), false);
  assert.equal(Object.hasOwn(form, "analysisChunkMode"), false);
  const moved = withPreset(form, "openai", saved);
  assert.deepEqual(normalize(settingsInput(moved, saved)).featureEfforts, saved.featureEfforts);
  assert.equal(normalize(settingsInput(moved, saved)).analysisChunkMode, "short");
  const custom = withAddress(withPreset(form, "custom", saved), { aiBaseUrl: "https://gateway.example.com/v1" }, saved);
  assert.deepEqual(normalize(settingsInput(custom, saved)).featureEfforts, saved.featureEfforts);
  // 表单打开以后才存下的档位：保存时拿最新存着的补全，不拿表单打开那一刻的盖回去。
  const later = savedWith({ ...saved, featureEfforts: { ...saved.featureEfforts, verdict: "medium" }, analysisChunkMode: "whole" });
  assert.equal(normalize(settingsInput(moved, later)).featureEfforts.verdict, "medium");
  assert.equal(normalize(settingsInput(moved, later)).analysisChunkMode, "whole");
});

test("推理强度：表单上的服务商、地址、模型和保存的不一样时，先不标实际档位", () => {
  const saved = savedWith({ presetId: "deepseek", aiApiKey: "sk-deep" });
  const form = formOf(saved);
  assert.equal(serviceChanged(form, saved), false);
  assert.equal(serviceChanged({ ...form, aiModel: ` ${saved.aiModel} ` }, saved), false, "前后空格不算改");
  assert.equal(serviceChanged({ ...form, aiModel: "other" }, saved), true);
  assert.equal(serviceChanged({ ...form, featureModels: { qa: "other" } }, saved), true);
  assert.equal(serviceChanged(withPreset(form, "openai", saved), saved), true);
});

test("推理强度旁边那一句：一样时不说；退了一档、关不掉、服务调不了各说一句；选关而服务说不准时不说", () => {
  assert.equal(effortNoteText({ requested: "high", effective: "high" }), null);
  assert.equal(effortNoteText({ requested: "medium", effective: "low", note: "fallback" }), "这个模型没有「中」档，实际按「低」档");
  assert.equal(effortNoteText({ requested: "high", effective: "off", note: "fallback" }), "这个模型调不了推理强度，实际按「关」");
  assert.equal(effortNoteText({ requested: "off", effective: "low", note: "cannot-disable" }), "这个模型关不掉思考，实际按最低的「低」档");
  assert.equal(effortNoteText({ requested: "high", effective: "off", note: "unknown" }), "这个服务调不了推理强度，由服务自己决定");
  assert.equal(effortNoteText({ requested: "off", effective: "off", note: "unknown" }), null);
});
