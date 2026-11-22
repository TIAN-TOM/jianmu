// 播放页上的界面语言：外观到之前跟随浏览器；外观里带了语言选项就按它，选项变了才算变；
// 认不出的选项、没带选项都按跟随浏览器。播放页上的字按语言出，中文那份照旧。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createContentLang, languageSettingOf } from "../../../src/content/lang.ts";
import { contentText } from "../../../src/content/text.ts";
import { NOTE_TITLE, noteIcon } from "../../../src/content/hover-icons.ts";
import { frameIcon } from "../../../src/content/frame-icon.ts";

test("外观到之前按浏览器的界面语言定", () => {
  assert.equal(createContentLang(() => "zh-CN").current(), "zh");
  assert.equal(createContentLang(() => "en-AU").current(), "en");
  assert.equal(createContentLang(() => "").current(), "en", "读不到界面语言时按英文");
});

test("外观里的语言选项：选了就按它，跟随浏览器时看界面语言；变了才回 true", () => {
  const lang = createContentLang(() => "zh-CN");
  assert.equal(lang.update({ accentTheme: "ink", inPageCard: true, language: "zh" }), false);
  assert.equal(lang.update({ accentTheme: "ink", inPageCard: true, language: "en" }), true);
  assert.equal(lang.current(), "en");
  assert.equal(lang.update({ language: "en" }), false);
  assert.equal(lang.update({ language: "auto" }), true);
  assert.equal(lang.current(), "zh");
});

test("繁体：选了繁体就按它；跟随浏览器时台湾、香港、澳门和带 Hant 的界面语言算繁体", () => {
  assert.equal(createContentLang(() => "zh-TW").current(), "zh-Hant");
  assert.equal(createContentLang(() => "zh_HK").current(), "zh-Hant");
  assert.equal(createContentLang(() => "zh-Hant-MO").current(), "zh-Hant");
  const lang = createContentLang(() => "zh-CN");
  assert.equal(lang.update({ language: "zh-Hant" }), true);
  assert.equal(lang.current(), "zh-Hant");
  assert.equal(lang.update({ language: "zh-Hant" }), false);
  assert.equal(lang.update({ language: "zh" }), true);
  assert.equal(languageSettingOf({ language: "zh-Hant" }), "zh-Hant");
  assert.equal(languageSettingOf({ language: "zh-TW" }), "auto");
});

test("没带语言选项、选项认不出时按跟随浏览器", () => {
  assert.equal(languageSettingOf({ accentTheme: "ink", inPageCard: true }), "auto");
  assert.equal(languageSettingOf({ language: "fr" }), "auto");
  assert.equal(languageSettingOf(null), "auto");
  assert.equal(languageSettingOf({ language: "en" }), "en");
  const lang = createContentLang(() => "en-US");
  assert.equal(lang.update({ accentTheme: "ink", inPageCard: true }), false);
  assert.equal(lang.current(), "en");
});

test("播放页上的字：中文照旧，英文是英文", () => {
  assert.equal(contentText().noteTitle, "在当前时间点记一条笔记（快捷键 n）");
  assert.equal(NOTE_TITLE, contentText("zh").noteTitle);
  assert.equal(noteIcon().title, NOTE_TITLE);
  assert.equal(noteIcon("en").title, "Add a note at the current time (shortcut: n)");
  assert.equal(contentText("en").cardTitle, "Jianmu summary card");
  assert.equal(frameIcon().title, "解释当前画面");
  assert.equal(frameIcon("en").title, "Explain this frame");
});

test("播放页上的字：繁体是繁体那份", () => {
  assert.equal(contentText("zh-Hant").noteTitle, "在目前時間點記一則筆記（快速鍵 n）");
  assert.equal(noteIcon("zh-Hant").title, contentText("zh-Hant").noteTitle);
  assert.equal(frameIcon("zh-Hant").title, "解釋目前畫面");
});
