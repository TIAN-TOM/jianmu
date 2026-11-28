// 侧边栏和共用组件的英文文案：产出文字的纯逻辑按传进来的语言写，缺省中文；英文里不夹中文。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoKey } from "../../../../src/core/video-ref.ts";
import { cardSetupHint, setupNotice, setupReason, type ConfigState } from "../../../../src/pages/shared/config.ts";
import { SHARED_EN } from "../../../../src/pages/shared/text-en.ts";
import { SHARED_HANT } from "../../../../src/pages/shared/text-hant.ts";
import { verdictName } from "../../../../src/core/ai/verdict.ts";
import { sharedTextOf } from "../../../../src/pages/shared/text.ts";
import { activationCopy, activationSections } from "../../../../src/pages/shared/ui/activation.ts";
import { chapterHeading } from "../../../../src/pages/shared/ui/chapters.ts";
import { basisText } from "../../../../src/pages/shared/ui/verdict.ts";
import { confirmText, progressText } from "../../../../src/pages/sidepanel/batch.ts";
import { frameText } from "../../../../src/pages/sidepanel/frame-text.ts";
import { openReadHint } from "../../../../src/pages/sidepanel/open-transcript.ts";
import { playerFailureText } from "../../../../src/pages/sidepanel/player.ts";
import { PANEL_EN } from "../../../../src/pages/sidepanel/text-en.ts";
import { PANEL_HANT } from "../../../../src/pages/sidepanel/text-hant.ts";
import { noteStored, panelTextOf } from "../../../../src/pages/sidepanel/text.ts";
import { youtubeText } from "../../../../src/pages/sidepanel/youtube-text.ts";
import type { WindowCountItem, WindowRunView } from "../../../../src/shared/messages/batch.ts";

const HAN = /[一-鿿]/;

/** 表里的每一条文字，函数用几个样例参数调一次。 */
function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (typeof value === "function") {
    const out = (value as (...args: unknown[]) => unknown)(3, 1, 1, 1);
    return typeof out === "string" ? [[path, out]] : [];
  }
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

test("英文表里没有中文：档位的键是数据里的中文词，只看显示名", () => {
  for (const [path, text] of [...strings(PANEL_EN), ...strings(SHARED_EN), ...strings(frameText("en")), ...strings(youtubeText("en")), ["openReadHint", openReadHint("en")] as [string, string]]) {
    assert.doesNotMatch(text, HAN, path);
  }
});

test("共用组件的纯逻辑：缺省中文，传 en 写英文", () => {
  assert.equal(chapterHeading(6, 2, "en"), "6 chapters, 2 key");
  assert.equal(chapterHeading(1, 0, "en"), "1 chapter");
  assert.equal(chapterHeading(6, 2, "zh"), "章节 6，重点 2");
  assert.equal(verdictName("推荐看", "en"), "Must watch");
  assert.equal(verdictName("值得看完整视频", "en"), "Must watch", "旧版改了名的按新名字显示");
  assert.equal(verdictName("看概览就够", "en"), "Mostly skippable");
  assert.equal(verdictName("可以跳过", "zh"), "可跳过");
  assert.equal(basisText("transcript", "en"), "Based on the subtitles");
  assert.equal(activationCopy(false, "en").confirm, "Turn on Jianmu");
  assert.equal(activationCopy(true, "en").confirm, "Keep using Jianmu");
  assert.deepEqual(
    activationSections([{ kind: "store", text: "a" }, { kind: "read", text: "b" }], "en").map((section) => section.heading),
    ["What it reads", "What's stored on this computer"],
  );
});

test("没设置好时的说法：按语言写，缺什么说什么", () => {
  const keyGone: ConfigState = { state: "checked", view: { ready: false, errors: [], missing: "key" } };
  const consent: ConfigState = { state: "checked", view: { ready: false, errors: [], missing: "consent" } };
  const fresh: ConfigState = { state: "checked", view: { ready: false, errors: [] } };
  assert.match(setupNotice(keyGone, "en"), /API key.*Remember the key on this computer/);
  assert.match(setupNotice(consent, "en"), /data notice/);
  assert.equal(setupReason(fresh, "en"), "Set up an AI service in settings first");
  assert.equal(setupReason({ state: "checked", view: { ready: true, errors: [] } }, "en"), undefined);
  assert.match(cardSetupHint(consent, "en"), /data notice/);
});

const video = (n: number) => `bilibili:BV1Sample00${n}:p1` as VideoKey;
const item = (n: number, state: WindowCountItem["state"]): WindowCountItem => ({ video: video(n), title: `Video ${n}`, state });

test("本窗口全部生成：英文的确认说明和进度", () => {
  assert.equal(confirmText([], "en"), "There are no videos open in this window.");
  assert.equal(confirmText([item(1, "to-generate"), item(2, "to-generate")], "en"), "This window has 2 videos. 2 overviews to generate.");
  assert.equal(confirmText([item(1, "existing"), item(2, "to-generate")], "en"), "This window has 2 videos. Skipping 1 with an overview already. 1 overview to generate.");
  assert.equal(
    confirmText([item(1, "existing"), item(2, "running"), item(3, "to-generate")], "en"),
    "This window has 3 videos. Skipping 2 (1 with an overview already, 1 being generated). 1 overview to generate.",
  );
  assert.equal(confirmText([item(1, "existing")], "en"), "This window has 1 video. 1 with an overview already, so there's nothing new to generate.");
  assert.equal(
    confirmText([item(1, "to-generate"), item(2, "open-each")], "en"),
    "This window has 1 video. 1 overview to generate. There's also 1 YouTube video to open one at a time. Click “Read subtitles” on each video page.",
  );
  assert.equal(confirmText([item(1, "open-each"), item(2, "open-each")], "en"), "This window has 2 YouTube videos to open one at a time. Click “Read subtitles” on each video page.");
  const run: WindowRunView = {
    stopping: false,
    entries: [
      { video: video(1), title: "One", status: "completed", partial: true },
      { video: video(2), title: "Two", status: "failed", failure: { code: "NO_CAPTIONS" } },
      { video: video(3), title: "Three", status: "skipped" },
    ],
  };
  assert.equal(progressText(run, "en"), "This window: 1 of 2 done, 1 incomplete, 1 failed, 1 skipped");
  assert.match(progressText({ ...run, stop: "rate-limited" }, "en"), /done, .*\. Bilibili is limiting requests/);
});

test("跳转失败、存笔记的结果：按语言写，存上没存上两种语言都认得出", () => {
  assert.equal(playerFailureText("NO_VIDEO", "en"), "Couldn't find a video on the page.");
  assert.equal(playerFailureText("NO_VIDEO", "zh"), "页面上没找到视频。");
  for (const lang of ["zh", "en"] as const) {
    assert.ok(noteStored(panelTextOf(lang).notes.saved));
    assert.ok(noteStored(panelTextOf(lang).notes.duplicate));
  }
  assert.ok(!noteStored("没能存下"));
  assert.ok(!noteStored(""));
});

test("选繁体时侧边栏和共用组件拿到繁体那份，不回落到简体", () => {
  assert.equal(panelTextOf("zh-Hant"), PANEL_HANT);
  assert.equal(sharedTextOf("zh-Hant"), SHARED_HANT);
  assert.equal(frameText("zh-Hant").button, "解釋畫面");
  assert.equal(youtubeText("zh-Hant").toSettings, "到設定頁啟用");
  assert.match(openReadHint("zh-Hant"), /^點選讀取，簡幕會替你打開/);
  assert.equal(chapterHeading(6, 2, "zh-Hant"), "章節 6，重點 2");
  assert.equal(activationCopy(false, "zh-Hant").confirm, "啟用簡幕");
  assert.equal(playerFailureText("NO_VIDEO", "zh-Hant"), "頁面上找不到影片。");
  assert.equal(noteStored(PANEL_HANT.notes.saved), true, "繁体界面下存上的笔记也认");
  assert.equal(noteStored(PANEL_HANT.notes.duplicate), true);
});
