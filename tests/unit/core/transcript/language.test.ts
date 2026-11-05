import assert from "node:assert/strict";
import { test } from "node:test";
import { guessSubtitleLanguage, isChineseSubtitle } from "../../../../src/core/transcript/language.ts";

test("认得出 B 站各种写法的中文字幕轨", () => {
  for (const code of ["zh-CN", "zh-Hans", "ai-zh", "AI-ZH", "zh"]) {
    assert.equal(isChineseSubtitle(code), true, `${code} 应判为中文`);
  }
});

test("外文字幕轨不判为中文", () => {
  for (const code of ["en-US", "ai-en", "ja", "ko"]) {
    assert.equal(isChineseSubtitle(code), false, `${code} 不应判为中文`);
  }
});

test("拿不到语言码时按中文处理", () => {
  // B 站以中文视频为主，猜中文猜错了只是少一个翻译入口，
  // 猜外文猜错了则会给一屏中文字幕摆上「翻译成中文」。
  assert.equal(isChineseSubtitle(""), true);
  assert.equal(isChineseSubtitle(null), true);
  assert.equal(isChineseSubtitle(undefined), true);
});

test("导入的字幕按正文猜语种：中文夹英文术语、英文夹中文地名都不改判", () => {
  const guess = (...texts: string[]): string => guessSubtitleLanguage(texts.map((text) => ({ text })));
  assert.equal(guess("我们用 Python 和 JavaScript 写代码", "第二句"), "zh-CN");
  assert.equal(guess("大家好欢迎来到我的频道", "Hello everyone welcome to my channel"), "zh-CN", "双语字幕按中文");
  assert.equal(guess("Today we talk about 北京"), "en");
  assert.equal(guess("今日は東京へ行きます"), "ja");
  assert.equal(guess("안녕하세요 여러분"), "ko");
  assert.equal(guess("Привет всем друзья"), "und");
  assert.equal(guess("123 456"), "zh-CN", "认不出字时按中文，和 isChineseSubtitle 的默认一致");
  assert.equal(isChineseSubtitle(guess("中文字幕")), true);
  assert.equal(isChineseSubtitle(guess("English subtitles")), false);
});
