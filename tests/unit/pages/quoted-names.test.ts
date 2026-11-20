// 英文的报错文案、启用说明、数据说明和各界面的说明里，用弯引号引了按钮、设置项和小节的名字。
// 每一个都要和界面上那个按钮或标题的英文一字不差，用户才找得到。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { contentText } from "../../../src/content/text.ts";
import { frameIcon } from "../../../src/content/frame-icon.ts";
import { CARD_EN } from "../../../src/pages/card/text-en.ts";
import { frameText as optionsFrameText } from "../../../src/pages/options/frame-text.ts";
import { OPTIONS_EN } from "../../../src/pages/options/text-en.ts";
import { youtubeText as optionsYoutubeText } from "../../../src/pages/options/youtube-text.ts";
import { SHARED_EN } from "../../../src/pages/shared/text-en.ts";
import { frameText as panelFrameText } from "../../../src/pages/sidepanel/frame-text.ts";
import { PANEL_EN } from "../../../src/pages/sidepanel/text-en.ts";
import { youtubeText as panelYoutubeText } from "../../../src/pages/sidepanel/youtube-text.ts";
import { TRIAGE_EN } from "../../../src/pages/triage/text-en.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SRC = join(ROOT, "src");

/** 视频网站自己界面上的名字：不是简幕的按钮，界面文案表里没有。 */
const SITE_NAMES: Readonly<Record<string, string>> = {
  "Show transcript": "YouTube 视频简介下面打开文字稿的按钮，报错的下一步教用户去点它",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** 源码里所有弯引号引用的名字（中文用「」，弯引号只出现在英文里）。带插值的是运行时才定的值，不算。 */
function quotedNames(): Map<string, string[]> {
  const names = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(/“([^”]+)”/g)) {
      const name = match[1] ?? "";
      if (name.includes("${")) continue;
      names.set(name, [...(names.get(name) ?? []), relative(ROOT, file)]);
    }
  }
  return names;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

/**
 * 英文文案表里的名字：整条文字，或者带说明的选项前面那段名字
 * （「Automatic (recommended)」的 Automatic，「Shorter: more requests, more reliable」的 Shorter）。
 */
function labels(): Set<string> {
  const tables: unknown[] = [
    SHARED_EN,
    OPTIONS_EN,
    PANEL_EN,
    CARD_EN,
    TRIAGE_EN,
    contentText("en"),
    frameIcon("en").title,
    panelFrameText("en"),
    optionsFrameText("en"),
    panelYoutubeText("en"),
    optionsYoutubeText("en"),
  ];
  const found = new Set<string>();
  for (const text of strings(tables)) {
    found.add(text);
    const named = /^(.+?)(?: \(|: )/.exec(text);
    if (named?.[1]) found.add(named[1]);
  }
  return found;
}

test("英文文案里引用的按钮、设置项和小节名字，都能在英文界面文案表里找到一字不差的同一个", () => {
  const names = quotedNames();
  assert.ok(names.size > 20, "收到的引用名字太少，多半是收集的写法坏了");
  const known = labels();
  const missing = [...names].filter(([name]) => !known.has(name) && !Object.hasOwn(SITE_NAMES, name)).map(([name, files]) => `“${name}”（${[...new Set(files)].join("、")}）`);
  assert.deepEqual(missing, []);
});

test("例外表里只放确实还在被引用、又不在简幕界面上的名字", () => {
  const names = quotedNames();
  const known = labels();
  for (const name of Object.keys(SITE_NAMES)) {
    assert.ok(names.has(name), `“${name}”已经没人引用，从例外表里删掉`);
    assert.ok(!known.has(name), `“${name}”是简幕自己界面上的名字，不该放进例外表`);
  }
});
