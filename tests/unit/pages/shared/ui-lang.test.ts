// 扩展页面的界面语言：启动时按首帧缓存和浏览器界面语言同步定下，外观落地时跟着设置纠正、跟着设置变；<html lang> 和标题跟着换。
import assert from "node:assert/strict";
import { test } from "node:test";
import { LANGUAGE_SETTINGS } from "../../../../src/core/output-lang.ts";
import { applyAppearance, watchAppearance, type WatchAppearanceDeps } from "../../../../src/pages/shared/theme.ts";
import { bindDocumentLang, byLang, cachedLanguage, initUiLang, inLang, setUiLanguage, uiLang } from "../../../../src/pages/shared/ui-lang.ts";
import { APPEARANCE_CACHE_KEY, SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { fakePage, memoryLocalStorage } from "../../../helpers/fake-page.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";

type Listener = Parameters<NonNullable<WatchAppearanceDeps["onChanged"]>["addListener"]>[0];

const cacheWith = (value: unknown) => memoryLocalStorage({ [APPEARANCE_CACHE_KEY]: JSON.stringify(value) });

test("启动时按首帧缓存里的语言选项同步定下界面语言：选了中文或英文就用它，跟随浏览器时看浏览器的界面语言", () => {
  assert.equal(initUiLang(cacheWith({ accentTheme: "ink", language: "en" }), "zh-CN"), "en");
  assert.equal(uiLang.value, "en");
  assert.equal(initUiLang(cacheWith({ language: "zh" }), "en-US"), "zh");
  assert.equal(uiLang.value, "zh");
  assert.equal(initUiLang(cacheWith({ language: "auto" }), "zh-TW"), "zh");
  assert.equal(initUiLang(cacheWith({ language: "auto" }), "en-GB"), "en");
});

test("没有缓存、缓存损坏、取值认不出、读存储抛错：都按跟随浏览器", () => {
  const throwing = { getItem: (): string | null => { throw new Error("存储被禁用"); } };
  const broken = memoryLocalStorage({ [APPEARANCE_CACHE_KEY]: "{oops" });
  for (const storage of [memoryLocalStorage(), broken, cacheWith({ language: "fr" }), cacheWith({ language: ["en"] }), cacheWith("en"), cacheWith(null), throwing, null, undefined]) {
    assert.equal(cachedLanguage(storage), "auto");
    assert.equal(initUiLang(storage, "zh-CN"), "zh");
    assert.equal(initUiLang(storage, "en-US"), "en");
  }
});

test("首帧缓存里的语言项和设置模块一致：外观落地写进去的每个取值，启动时都原样读回来", () => {
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage });
  for (const language of LANGUAGE_SETTINGS) {
    applyAppearance({ language }, root);
    assert.equal(cachedLanguage(localStorage), language);
  }
  // 设置里认不出的值按设置模块规整成跟随浏览器再记。
  applyAppearance({ language: "de" }, root);
  assert.equal(cachedLanguage(localStorage), "auto");
});

test("外观落地时跟着设置纠正界面语言，设置变了跟着变，别处的变化不理", async () => {
  const local = memoryStorage({ [SETTINGS_STORAGE_KEY]: { language: "en" } });
  const listeners = new Set<Listener>();
  const deps: WatchAppearanceDeps = {
    local: { get: (key) => local.get(key) },
    onChanged: { addListener: (listener) => void listeners.add(listener), removeListener: (listener) => void listeners.delete(listener) },
  };
  const emit = (changes: Record<string, { newValue?: unknown }>, area = "local"): void => {
    for (const listener of [...listeners]) listener(changes, area);
  };
  const { root } = fakePage();
  // 首帧缓存说中文，设置里其实是英文：读回设置以后改成英文。
  initUiLang(cacheWith({ language: "zh" }), "zh-CN");
  const watch = await watchAppearance(deps, root);
  assert.equal(uiLang.value, "en");

  emit({ [SETTINGS_STORAGE_KEY]: { newValue: { language: "zh" } } });
  assert.equal(uiLang.value, "zh");
  emit({ [SETTINGS_STORAGE_KEY]: { newValue: { language: "en" } } }, "session");
  emit({ other: { newValue: { language: "en" } } });
  assert.equal(uiLang.value, "zh");

  watch.stop();
  emit({ [SETTINGS_STORAGE_KEY]: { newValue: { language: "en" } } });
  assert.equal(uiLang.value, "zh");
});

test("<html lang> 和页面标题跟着界面语言换，停止以后不再跟", () => {
  const doc = { documentElement: { lang: "zh-CN" }, title: "" };
  setUiLanguage("zh");
  const stop = bindDocumentLang(doc, (lang) => (lang === "en" ? "Settings" : "设置"));
  assert.deepEqual(doc, { documentElement: { lang: "zh-CN" }, title: "设置" });
  setUiLanguage("en");
  assert.deepEqual(doc, { documentElement: { lang: "en" }, title: "Settings" });
  stop();
  setUiLanguage("zh");
  assert.deepEqual(doc, { documentElement: { lang: "en" }, title: "Settings" });
});

test("取文案：byLang 按当前界面语言取，inLang 按给定的语言取", () => {
  setUiLanguage("en");
  assert.equal(byLang("中", "en"), "en");
  setUiLanguage("zh");
  assert.equal(byLang("中", "en"), "中");
  assert.equal(inLang("en", "中", "en"), "en");
  assert.equal(inLang("zh", "中", "en"), "中");
});
