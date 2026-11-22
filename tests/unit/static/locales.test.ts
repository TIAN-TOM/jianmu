// 扩展的名称、简介和工具栏图标的提示由浏览器按界面语言从区域文件里取：每个区域都齐全，和清单引用的名字对得上，字数在浏览器的上限以内。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { charsIn, SIMPLIFIED_ONLY, TRADITIONAL_ONLY } from "../../helpers/hant-chars.ts";

const ROOT = new URL("../../../", import.meta.url);
const TEMPLATE = readFileSync(new URL("manifest.template.json", ROOT), "utf8");
const LOCALES_DIR = new URL("static/_locales/", ROOT);

type Messages = Record<string, { message: string }>;
const messagesOf = (locale: string): Messages => JSON.parse(readFileSync(new URL(`${locale}/messages.json`, LOCALES_DIR), "utf8"));

const ENGLISH = {
  extensionName: "Jianmu: Watch or Skip, Then Study",
  extensionDescription: "Decide in minutes whether a long YouTube or Bilibili video is worth watching, then study it closely. Uses your own API key.",
  actionTitle: "Open Jianmu",
};
const CHINESE = {
  extensionName: "简幕：AI 视频速览与学习助手",
  extensionDescription: "几分钟判断一个 B 站或 YouTube 长视频值不值得看、重点看哪段；决定看了，再陪你精读。",
  actionTitle: "打开简幕",
};
const TRADITIONAL = {
  extensionName: "簡幕：AI 影片速覽與學習助手",
  extensionDescription: "幾分鐘判斷一部 B 站或 YouTube 長影片值不值得看、重點看哪段；決定看了，再陪你精讀。",
  actionTitle: "打開簡幕",
};
// 缺省是英文；zh_TW 是繁体，zh、zh_CN 是简体。浏览器只认 zh_CN、zh_TW 两个带地区的中文区域，不认 zh_HK：
// 香港、澳门的界面语言找不到同名的区域，按去掉地区的 zh 取，看到的是简体。
const EXPECTED: Readonly<Record<string, Record<string, string>>> = { en: ENGLISH, zh: CHINESE, zh_CN: CHINESE, zh_TW: TRADITIONAL };

// 浏览器的上限：名称 75 个字符，简介 132 个字符。
const LIMITS: Readonly<Record<string, number>> = { extensionName: 75, extensionDescription: 132 };

test("清单的名称、简介和图标提示都从区域文件取，缺省区域是英文", () => {
  const manifest = JSON.parse(TEMPLATE);
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extensionName__");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
  assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
});

test("区域目录就是这几个，每份的消息名和清单引用的一样，文字就是定下的那份", () => {
  assert.deepEqual(readdirSync(LOCALES_DIR).sort(), Object.keys(EXPECTED).sort());
  const referenced = [...new Set([...TEMPLATE.matchAll(/__MSG_(\w+)__/g)].map((match) => match[1] ?? ""))].sort();
  for (const [locale, expected] of Object.entries(EXPECTED)) {
    const messages = messagesOf(locale);
    assert.deepEqual(Object.keys(messages).sort(), referenced, `${locale} 的消息名和清单引用的对不上`);
    for (const entry of Object.values(messages)) assert.deepEqual(Object.keys(entry), ["message"], `${locale} 每条只写 message`);
    assert.deepEqual(Object.fromEntries(Object.entries(messages).map(([name, entry]) => [name, entry.message])), expected, locale);
  }
});

test("名称和简介不超过浏览器的字数上限", () => {
  for (const locale of Object.keys(EXPECTED)) {
    const messages = messagesOf(locale);
    for (const [name, limit] of Object.entries(LIMITS)) {
      const length = [...(messages[name]?.message ?? "")].length;
      assert.ok(length > 0 && length <= limit, `${locale} 的 ${name} 有 ${length} 个字符，上限 ${limit}`);
    }
  }
});

test("繁体那份没有简体专用字，简体那几份没有繁体专用字", () => {
  const all = (locale: string): string => Object.values(messagesOf(locale)).map((entry) => entry.message).join("\n");
  assert.deepEqual(charsIn(all("zh_TW"), SIMPLIFIED_ONLY), []);
  for (const locale of ["zh", "zh_CN"]) assert.deepEqual(charsIn(all(locale), TRADITIONAL_ONLY), [], locale);
});
