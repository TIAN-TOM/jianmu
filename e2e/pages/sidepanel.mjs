// 侧边栏：确认启用前只有启用说明；没有视频时说明怎么用；视频页上读不到字幕、读到字幕，速读和精读、问答抽屉、笔记层的主要状态；
// 打开时按时长定模式，主动切换记住频道，设置页清掉以后回到按时长；换了字幕以后，依据旧字幕的结论和问答标出来；
// 同一个视频换到另一个标签页时重读本机的概览和问答。
// 页面测试里没有设置模型服务的密钥：概览和问答停在要先设置 AI 服务。
// 几个测试按顺序共用同一个浏览器：第一个确认启用，第二个还没登录，第三个起已登录。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ACTIVATION_TABLE, noticeLines, noticeStatus } from "../../src/core/consent.ts";
import { errorCopy } from "../../src/core/errors.ts";
import { translationId } from "../../src/core/notes/records.ts";
import { textFingerprint } from "../../src/core/transcript/fingerprint.ts";
import { channelKey, videoKey } from "../../src/core/video-ref.ts";
import { API_KEY_SESSION_KEY, AUTO_LEDGER_KEY, DATABASE_NAME, OPEN_PANELS_KEY, SETTINGS_STORAGE_KEY, TRANSCRIPT_MODES_KEY, WATCH_SESSIONS_KEY } from "../../src/shared/names.ts";
import { ANTHROPIC, BRIEF_SAMPLE, PLAYING_SAMPLE, VIDEOS } from "../fixtures.mjs";
import { playingWatchPage, PROBE, watchPage } from "../mock-server.mjs";
import { storedSettings } from "../settings.mjs";
import { charsIn, SIMPLIFIED_ONLY } from "../../tests/helpers/hant-chars.ts";
import { stillFalse } from "../../tests/helpers/wait-until.ts";
import { PANEL_HANT } from "../../src/pages/sidepanel/text-hant.ts";
import { SHARED_HANT } from "../../src/pages/shared/text-hant.ts";
import { scenario, until } from "./harness.mjs";

const test = scenario(import.meta.url);
const LAUNCHER = "pages/gallery.html";
const [FIRST_ID = ""] = Object.keys(VIDEOS);
const FIRST_TITLE = VIDEOS[FIRST_ID]?.title ?? "";
const VIDEO = videoKey({ platform: "bilibili", videoId: FIRST_ID });
const FULL_ACTIVATION = noticeStatus(ACTIVATION_TABLE, {});
const FULL_ACTIVATION_ITEMS = FULL_ACTIVATION.state === "needed" ? FULL_ACTIVATION.items : [];

const appText = `(document.getElementById("app")?.innerText ?? "")`;
/** 文字里的简体专用字，繁体界面上应当一个都没有。 */
const simplifiedIn = (text) => charsIn(String(text ?? ""), SIMPLIFIED_ONLY);
const textOf = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent).join("\\n")`;

/** 在 page 所在的窗口里开一个标签页，回它的编号。 */
const openTab = (page, url, active = true) =>
  page.evaluate(`chrome.windows.getCurrent().then((win) => chrome.tabs.create({ windowId: win.id, url: ${JSON.stringify(url)}, active: ${active} })).then((tab) => tab.id)`);
const closeTab = (from, tabId) => from.evaluate(`chrome.tabs.remove(${tabId}).then(() => true, () => true)`);

/** 侧边栏开在启动页的窗口里，再在侧边栏所在的窗口里打开视频页；做完关掉视频页。每次新开的标签页是一次新的观看。 */
async function withVideo({ open, openSidePanel }, fn, videoId = FIRST_ID, url = watchPage(videoId)) {
  const from = await open(LAUNCHER);
  const panel = await openSidePanel(from);
  const tabId = await openTab(panel, url);
  try {
    await waitIn(panel, "模式切换出来", `Boolean(document.querySelector(".modes"))`);
    await fn(panel, from, tabId);
  } finally {
    await closeTab(from, tabId);
  }
}

const modes = `[...document.querySelectorAll(".mode")].map((node) => [node.textContent, node.getAttribute("aria-checked")])`;
/** 问答抽屉：字幕列表里还有一个划词解释的抽屉，按标题认。 */
const qaSheet = `[...document.querySelectorAll(".sheet")].find((node) => node.querySelector(".overlay-title")?.textContent === "问答")`;
const SKIM = [
  ["速读", "true"],
  ["精读", "false"],
];
const STUDY = [
  ["速读", "false"],
  ["精读", "true"],
];

/** 按条件等；等不到时把侧边栏上的文字带进报错，看得出停在哪。 */
async function waitIn(panel, label, expression, timeoutMs) {
  try {
    return await panel.waitFor(label, expression, timeoutMs);
  } catch (error) {
    const shown = await panel.evaluate(appText).catch(() => "");
    throw new Error(`${error.message}\n侧边栏上显示：${shown.slice(0, 400)}`);
  }
}

// 无头 Chrome 里经调试协议发的鼠标事件落不进侧边栏，侧边栏里的点击都在页面里调 click()。
const tap = async (page, selector) => {
  const done = await page.evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
  if (!done) throw new Error(`找不到 ${selector}`);
};

const clickText = (page, selector, text) =>
  page.evaluate(`(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.includes(${JSON.stringify(text)})); if (!node) return false; node.click(); return true; })()`);

/**
 * 无头 Chrome 里写剪贴板可能被拒：把侧边栏的写剪贴板换成记下来，看复制了什么。几个测试共用同一个侧边栏，每次从空的记起。
 * 复制以后顶上一行说「已复制」，笔记层开着时在层里说。
 */
const recordClipboard = `(window.copiedTexts = [], navigator.clipboard.writeText = async (text) => { window.copiedTexts.push(text); }, true)`;
const copiedTexts = `window.copiedTexts ?? []`;
const copiedSaid = `[...document.querySelectorAll(".notice-text, .layer-toast")].some((node) => node.textContent === "已复制")`;

test("侧边栏：确认启用前只有启用说明，点启用以后说明怎么打开视频", async ({ open, openSidePanel }) => {
  const from = await open(LAUNCHER);
  const panel = await openSidePanel(from);
  await waitIn(panel, "启用说明", `${appText}.includes("先看看简幕会读什么")`);
  assert.equal(await panel.evaluate(`document.querySelectorAll(".mode").length`), 0, "确认前没有模式切换");
  // English 下启用说明的条目也是英文，整块说明里没有汉字；切回中文再往下走。
  const before = await setLanguage(panel, "en");
  try {
    await waitIn(panel, "界面换成英文", `document.documentElement.lang === "en"`);
    const lines = await panel.evaluate(`[...document.querySelectorAll(".activation .activation-lines li")].map((node) => node.textContent)`);
    assert.deepEqual([...lines].sort(), noticeLines(FULL_ACTIVATION_ITEMS, "en").map((line) => line.text).sort());
    assert.doesNotMatch(await panel.evaluate(`document.querySelector(".activation").innerText`), /[\u3400-\u9fff]/);
  } finally {
    await restoreSettings(panel, before);
  }
  await waitIn(panel, "界面换回中文", `document.documentElement.lang === "zh-CN"`);
  // 繁体下启用说明的条目是繁体那份，整块说明里没有简体专用字。
  const beforeHant = await setLanguage(panel, "zh-Hant");
  try {
    await waitIn(panel, "界面换成繁体", `document.documentElement.lang === "zh-Hant"`);
    const lines = await panel.evaluate(`[...document.querySelectorAll(".activation .activation-lines li")].map((node) => node.textContent)`);
    assert.deepEqual([...lines].sort(), noticeLines(FULL_ACTIVATION_ITEMS, "zh-Hant").map((line) => line.text).sort());
    const block = await panel.evaluate(`document.querySelector(".activation").innerText`);
    assert.deepEqual(simplifiedIn(block), [], block);
  } finally {
    await restoreSettings(panel, beforeHant);
  }
  await waitIn(panel, "界面换回简体", `document.documentElement.lang === "zh-CN"`);
  await tap(panel, ".activation .button");
  await waitIn(panel, "没有视频时的说明", `${appText}.includes("打开一个 B 站或 YouTube 视频")`);
  // 测试构建里 YouTube 开关打开；没给过授权，认不出视频的页面都带启用按钮。
  await waitIn(panel, "YouTube 的启用按钮", `[...document.querySelectorAll(".state-block .button")].map((node) => node.textContent.trim()).join() === "在 YouTube 上启用"`);
});

test("侧边栏：没登录时也读到视频信息，长视频进速读；字幕那块说明原因，给重试和导入字幕文件，标题用读到的", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    const login = errorCopy("NEED_LOGIN");
    await waitIn(panel, "要登录的说明", `document.querySelector(".state-block .state-title")?.textContent === ${JSON.stringify(login.cause)}`);
    const state = await panel.evaluate(`({
      modes: ${modes},
      impact: document.querySelector(".state-block .state-impact")?.textContent,
      next: document.querySelector(".state-block .state-next")?.textContent,
      actions: [...document.querySelectorAll(".state-block .button")].map((button) => button.textContent),
      title: document.querySelector(".video-title")?.textContent ?? "",
    })`);
    assert.deepEqual(state.modes, SKIM);
    assert.deepEqual(state.actions, ["重试", "导入字幕文件"]);
    assert.equal(state.impact, login.impact);
    assert.equal(state.next, login.next);
    assert.ok(state.title.includes(FIRST_TITLE), `没登录也用读到的视频标题：${state.title}`);

    // English 下同一块的原因、影响、下一步和按钮是英文。
    const english = errorCopy("NEED_LOGIN", undefined, "en");
    const before = await setLanguage(panel, "en");
    try {
      await waitIn(panel, "要登录的说明换成英文", `document.querySelector(".state-block .state-title")?.textContent === ${JSON.stringify(english.cause)}`);
      const shown = await panel.evaluate(`({
        impact: document.querySelector(".state-block .state-impact")?.textContent,
        next: document.querySelector(".state-block .state-next")?.textContent,
        actions: [...document.querySelectorAll(".state-block .button")].map((button) => button.textContent),
      })`);
      assert.deepEqual(shown, { impact: english.impact, next: english.next, actions: ["Try again", "Import subtitle file"] });
    } finally {
      await restoreSettings(panel, before);
    }

    // 繁体下同一块的原因、影响、下一步和按钮是繁体。
    const hant = errorCopy("NEED_LOGIN", undefined, "zh-Hant");
    const beforeHant = await setLanguage(panel, "zh-Hant");
    try {
      await waitIn(panel, "要登录的说明换成繁体", `document.querySelector(".state-block .state-title")?.textContent === ${JSON.stringify(hant.cause)}`);
      const shown = await panel.evaluate(`({
        impact: document.querySelector(".state-block .state-impact")?.textContent,
        next: document.querySelector(".state-block .state-next")?.textContent,
        actions: [...document.querySelectorAll(".state-block .button")].map((button) => button.textContent),
      })`);
      assert.deepEqual(shown, { impact: hant.impact, next: hant.next, actions: [PANEL_HANT.retry, PANEL_HANT.transcript.importFile] });
      assert.deepEqual(simplifiedIn([hant.cause, hant.impact, hant.next].join("")), []);
    } finally {
      await restoreSettings(panel, beforeHant);
    }
  });
});

const pressAtFocus = (page, key) => page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
const typeSearch = (page, text) => page.call(`(value) => {
  const input = document.querySelector(".search-row input");
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}`, text);

test("侧边栏：登录以后长视频进速读，还没有概览时下面接着字幕；搜索只留命中的段落并高亮", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const login = await openTab(from, PROBE.login, false);
  await closeTab(from, login);
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕列出来", `${textOf(".cue-text")}.includes("样例台词二")`);
    assert.deepEqual(await panel.evaluate(modes), SKIM);
    assert.equal(await panel.evaluate(`Boolean(document.querySelector(".skim .skim-transcript .cues"))`), true, "字幕摆在速读里");
    // 速读里的字幕不跟着播放滚动：知道播放位置以后出「回到当前句」，侧边栏没被拉下去。
    await waitIn(panel, "知道播放位置", `Boolean(document.querySelector(".follow-pill[data-shown]"))`);
    assert.equal(await panel.evaluate("scrollY"), 0, "侧边栏没被字幕拉着滚");
    // 往下滚，模式切换吸在顶上。
    await panel.evaluate(`(document.querySelector(".panel").style.minHeight = "3000px", scrollTo(0, 2000), true)`);
    await waitIn(panel, "滚下去了", "scrollY > 0");
    assert.ok(Math.abs(await panel.evaluate(`document.querySelector(".mode-row").getBoundingClientRect().top`)) < 1, "模式切换吸在顶上");
    await panel.evaluate(`(document.querySelector(".panel").style.minHeight = "", scrollTo(0, 0), true)`);
    assert.match(await panel.evaluate(textOf(".toolbar-count")), /^共 \d+ 段$/);
    // 自造的语音识别字幕没有标点：一段里的两行原始字幕分开显示，拼起来的文字和原文一样，划词解释取的上下文不变。
    const firstCue = await panel.evaluate(`(() => { const cue = document.querySelector(".cue-text"); return { lines: [...cue.querySelectorAll(".cue-line")].map((line) => line.textContent), text: cue.textContent }; })()`);
    assert.deepEqual(firstCue, { lines: ["样例台词一", "样例台词二"], text: "样例台词一样例台词二" });
    const search = ".search-row input";
    await panel.evaluate(`document.querySelector(".ask-entry input").focus(), true`);
    assert.equal(await pressAtFocus(panel, "/"), true, "问答输入框里能输入斜杠");
    assert.equal(await panel.evaluate(`document.activeElement.matches(".ask-entry input") && !document.querySelector("${search}")`), true);
    await panel.evaluate(`document.querySelector(".cue-time").focus(), true`);
    assert.equal(await pressAtFocus(panel, "/"), false);
    await waitIn(panel, "斜杠聚焦字幕搜索", `document.activeElement.matches("${search}")`);
    await typeSearch(panel, "台词二");
    await waitIn(panel, "只留命中的段落", `document.querySelectorAll(".cue").length === 1 && document.querySelector(".cue mark")?.textContent === "台词二"`);
    assert.equal(await panel.evaluate(`document.querySelector(".cue mark")?.closest(".cue-line")?.textContent`), "样例台词二", "高亮落在第二行里");
    assert.equal(await panel.evaluate(textOf(".search-count")), "1 处");
    assert.equal(await pressAtFocus(panel, "/"), true, "搜索框自己能输入斜杠");
    assert.equal(await pressAtFocus(panel, "Escape"), false);
    await waitIn(panel, "搜索收起并恢复全部段落", `!document.querySelector("${search}") && !document.querySelector(".cue mark")`);
    await waitIn(panel, "搜索按钮可用", `Boolean(document.querySelector("button[aria-label='搜索字幕']"))`);
    await tap(panel, "button[aria-label='搜索字幕']");
    await waitIn(panel, "再次打开时搜索词已清空", `document.activeElement.matches("${search}") && document.activeElement.value === ""`);
  });
});

test("侧边栏：搜索字幕时，译文、整理后的字幕和原始字幕都能作为命中行显示", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕列出来", `Boolean(document.querySelector(".cue"))`);
    const read = await panel.evaluate(`chrome.runtime.sendMessage({ type: "transcript.get", req: { video: ${JSON.stringify(VIDEO)}, mode: "cache-only" } })`);
    assert.equal(read.ok, true);
    const { ref, segments } = read.value.transcript;
    const hash = await textFingerprint(segments[0].text);
    const record = (target, text) => ({
      id: translationId(ref, target), video: VIDEO, transcript: ref, target, segments: { [hash]: text },
      derived: { basis: { source: "transcript", transcript: ref }, gen: { feature: target === "tidy" ? "tidy" : "rewrite", promptVersion: "p", model: "sample", effort: "off" } }, updatedAt: 1,
    });
    const records = [record("en", "A painted moon"), record("tidy", "样例旁白。")];
    await editDatabase(panel, { translations: records });
    try {
      await panel.reload();
      await waitIn(panel, "缓存的整理结果显示", `${textOf(".cue-text")}.includes("样例旁白。")`);
      await pressAtFocus(panel, "/");
      await waitIn(panel, "搜索框打开", `document.activeElement.matches(".search-row input")`);
      await typeSearch(panel, "台词二");
      await waitIn(panel, "原始字幕的命中行高亮", `document.querySelector(".cue-sub mark")?.textContent === "台词二"`);
      await typeSearch(panel, "moon");
      await waitIn(panel, "译文的命中行高亮", `document.querySelector(".cue-sub mark")?.textContent === "moon"`);
      assert.equal(await panel.evaluate(textOf(".cue-text")), "样例旁白。");
      await waitIn(panel, "可以切回原始字幕", `${textOf(".tidy-row button")}.includes("看原始字幕")`);
      assert.ok(await clickText(panel, ".tidy-row button", "看原始字幕"));
      await typeSearch(panel, "旁白");
      await waitIn(panel, "收起的整理结果也高亮", `document.querySelector(".cue-sub mark")?.textContent === "旁白"`);
      assert.equal(await panel.evaluate(textOf(".cue-text")), segments[0].text);
    } finally {
      await editDatabase(panel, {}, { translations: records.map(({ id }) => id) });
    }
  });
});

test("侧边栏：重开后恢复这个视频的双语显示，缺译文的段保留原文，不发起翻译", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    const button = ".toolbar .menu-anchor:has([aria-label='字幕视图']) > button";
    const list = "[aria-label='字幕视图']:popover-open";
    await waitIn(panel, "字幕和视图按钮出现", `Boolean(document.querySelector(".cue-text") && document.querySelector(${JSON.stringify(button)}))`);
    const send = (type, req) => panel.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);
    const first = "画室里的学生拿起画笔在白纸上描出月光落在河面时最明亮的那道银色轮廓。";
    const second = "窗外的月亮升高了。";
    const srt = `1\n00:00:01,000 --> 00:00:07,000\n${first}\n\n2\n00:00:28,000 --> 00:00:32,000\n${second}\n`;
    let recordId;
    const settings = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const session = await panel.evaluate(`chrome.storage.session.get(${JSON.stringify([TRANSCRIPT_MODES_KEY, API_KEY_SESSION_KEY])})`);
    const stored = await storedSettings(ANTHROPIC);
    try {
      assert.equal((await send("imports.add", { video: VIDEO, fileName: "月光.srt", text: srt })).ok, true);
      const read = await send("transcript.get", { video: VIDEO, mode: "full" });
      assert.equal(read.ok, true);
      const { ref, segments } = read.value.transcript;
      assert.deepEqual(segments.map(({ text }) => text), [first, second]);
      const hash = await textFingerprint(first);
      recordId = translationId(ref, "en");
      const translated = "Moonlight on the water.";
      await editDatabase(panel, { translations: [{
        id: recordId, video: VIDEO, transcript: ref, target: "en", segments: { [hash]: translated },
        derived: { basis: { source: "transcript", transcript: ref }, gen: { feature: "rewrite", promptVersion: "p", model: "sample", effort: "off" } }, updatedAt: 1,
      }] });
      await panel.reload();
      // 工具栏可能比字幕晚一拍渲染出来，点之前连按钮一起等。
      await waitIn(panel, "样例的两段字幕和视图按钮出现", `${textOf(".cue-text")} === ${JSON.stringify(first + "\n" + second)} && Boolean(document.querySelector(${JSON.stringify(button)}))`);
      await tap(panel, button);
      await waitIn(panel, "双语选项出现", `${textOf(list + " .menu-label")}.includes("双语")`);
      assert.ok(await clickText(panel, list + " .menu-item", "双语"));
      const remembered = `chrome.runtime.sendMessage({ type: "transcript.displayMode", req: { video: ${JSON.stringify(VIDEO)} } }).then((reply) => reply.value?.mode)`;
      await waitIn(panel, "已记住双语", `${remembered}.then((mode) => mode === "bilingual")`);
      // 要到设置页去改的错：那一句下面跟着「打开设置」；没设置好时不摆「接着翻译」。
      await waitIn(panel, "第一次主动翻译因服务未设置而结束", `${textOf(".cue-tools .settings-exit .button")} === "打开设置"`);
      assert.equal(await panel.evaluate(`${textOf(".cue-tools .progress-row .button")}.includes("接着翻译")`), false);
      await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
      const since = ctx.requests.length;
      await panel.reload();
      await waitIn(panel, "双语恢复，只有第一段显示译文，第二段保留原文", `${textOf(button)} === "双语" && ${textOf(".cue:first-child .cue-sub")} === ${JSON.stringify(translated)} && ${textOf(".cue:nth-child(2) .cue-text")} === ${JSON.stringify(second)} && !document.querySelector(".cue:nth-child(2) .cue-sub")`);
      await tap(panel, button);
      await waitIn(panel, "再次点双语会用额度", `[...document.querySelectorAll(${JSON.stringify(list + " .menu-item")})].some((item) => item.querySelector(".menu-label")?.textContent === "双语" && item.querySelector(".menu-hint")?.textContent.includes("额度"))`);
      assert.ok(await stillFalse(() => ctx.requests.slice(since).some((item) => "kind" in item), 20), `恢复双语以后的模型请求：${ctx.requests.slice(since).flatMap((item) => item.kind ?? [])}`);
    } finally {
      if (recordId) await editDatabase(panel, {}, { translations: [recordId] });
      await send("imports.remove", { video: VIDEO });
      await panel.evaluate(`chrome.storage.session.remove(${JSON.stringify([TRANSCRIPT_MODES_KEY, API_KEY_SESSION_KEY])}).then(() => chrome.storage.session.set(${JSON.stringify(session)}))`);
      await panel.evaluate(`chrome.storage.local.set(${JSON.stringify(settings)})`);
    }
  });
});

test("侧边栏：字幕选区能直接存笔记，保留选中文字和所在段起点", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    const send = (type, req) => panel.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);
    const sample = "纸上画着半轮明月。";
    const selection = "半轮明月";
    const srt = `1\n00:00:37,000 --> 00:00:42,000\n${sample}\n`;
    const selectWords = () => panel.call(`(sample, words) => {
      const cue = [...document.querySelectorAll(".cue-text")].find((item) => item.textContent === sample);
      const start = sample.indexOf(words);
      const range = document.createRange();
      range.setStart(cue.firstChild, start);
      range.setEnd(cue.firstChild, start + words.length);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      cue.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }`, sample, selection);
    const action = (label) => `[...document.querySelectorAll(".explain-pick button")].find((button) => button.textContent === ${JSON.stringify(label)} && !button.disabled)`;
    const notes = `chrome.runtime.sendMessage({ type: "notes.list", req: { video: ${JSON.stringify(VIDEO)} } }).then((reply) => reply.value.notes)`;
    const before = await panel.evaluate(notes);
    const settings = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    assert.equal((await send("imports.add", { video: VIDEO, fileName: "选区.srt", text: srt })).ok, true);
    try {
      await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
      await panel.reload();
      await waitIn(panel, "选区样例显示", `${textOf(".cue-text")} === ${JSON.stringify(sample)}`);
      await selectWords();
      await waitIn(panel, "选区有解释和存笔记", `Boolean(${action("解释")} && ${action("存笔记")})`);
      const since = ctx.requests.length;
      // 在浮条上松开鼠标时，选区可能已经收起；松开的事件还会冒泡到字幕列表。
      await panel.evaluate(`(() => {
        const button = ${action("存笔记")};
        button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        getSelection().removeAllRanges();
        button.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      })()`);
      await waitIn(panel, "松开鼠标后存笔记仍可点击", `Boolean(${action("存笔记")})`);
      assert.ok(await clickText(panel, ".explain-pick button", "存笔记"));
      const saved = await panel.waitFor("选中文字已存入笔记", `${notes}.then((rows) => rows.find((row) => row.text === ${JSON.stringify(selection)}))`);
      assert.equal(saved.atSec, 37);
      assert.equal(saved.quote, undefined);
      // 存过笔记的那句带上标记；荧光笔主题把它用荧光笔划出来，别的主题不划。
      await waitIn(panel, "存过笔记的那句标出来", `[...document.querySelectorAll(".cue[data-saved='true'] .cue-text")].some((node) => node.textContent === ${JSON.stringify(sample)})`);
      const stroke = `getComputedStyle(document.querySelector(".cue[data-saved='true'] .cue-text")).textDecorationLine`;
      await panel.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: 100 });
      assert.equal(await panel.evaluate(stroke), "underline", "荧光笔主题划出来");
      await panel.setAppearance({ accentTheme: "timecode", themeMode: "light", uiFontScale: 100 });
      assert.equal(await panel.evaluate(stroke), "none", "别的主题不划");
      await panel.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: 100 });
      assert.ok(await stillFalse(() => ctx.requests.slice(since).some((item) => "kind" in item), 20), "存笔记不请求模型");
    } finally {
      const added = (await panel.evaluate(notes)).filter((row) => !before.some((old) => old.id === row.id));
      for (const row of added) await send("notes.delete", { id: row.id });
      await send("imports.remove", { video: VIDEO });
      await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify(settings)}), chrome.storage.session.remove(${JSON.stringify(API_KEY_SESSION_KEY)})]).then(() => true)`);
    }
  });
});

test("侧边栏：速读还没有概览时先摆官方总结；没设置 AI 服务时「生成概览」的位置是能点的「设置 AI 服务」，本窗口全部生成和整理字幕先不摆", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await waitIn(panel, "官方总结", `${textOf(".guide-summary")}.includes("这是自造的样例总结。")`);
    assert.equal(await panel.evaluate(`document.querySelector(".guide .section-title")?.textContent`), "B 站官方总结");
    await waitIn(panel, "设置 AI 服务的主按钮", `[...document.querySelectorAll(".ai-overview .button")].some((node) => node.textContent === "设置 AI 服务" && !node.disabled && node.dataset.variant === "primary")`);
    const shown = await panel.evaluate(`({
      generate: [...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览"),
      batch: Boolean(document.querySelector(".batch-start, .batch-bar")),
      tidy: Boolean(document.querySelector(".tidy-row .button")),
      reasons: document.querySelectorAll(".ai-overview .control-reason").length,
      exportStudy: [...document.querySelectorAll(".ai-overview .button")].some((node) => node.textContent === "导出学习稿"),
    })`);
    assert.deepEqual(shown, { generate: false, batch: false, tidy: false, reasons: 0, exportStudy: true }, "有官方总结可导，导出学习稿摆着");
    assert.equal(await panel.evaluate(`document.querySelector(".mode-view")?.getAttribute("aria-label")`), "速读");
    assert.ok((await panel.evaluate(textOf(".outline-title"))).includes("样例小节"), "官方总结的提纲也在");
  });
});

const OPTIONS_PATH = "/pages/options.html";
const optionsView = `chrome.extension.getViews({ type: "tab" }).find((view) => view.location.pathname === ${JSON.stringify(OPTIONS_PATH)})`;
/** 设置页「AI 服务」一节的顶边在视口里的位置、页面滚了多少、地址里还带不带节名；设置页没开或没渲染出这一节时是 null。滚到那一节后顶边可能差不到一像素，按零算。 */
const aiSectionAt = `(() => { const view = ${optionsView}; const top = view?.document.getElementById("ai-service")?.getBoundingClientRect().top; return top === undefined ? null : { top, scrolled: view.scrollY, hash: view.location.hash }; })()`;
const closeOptions = `chrome.runtime.getContexts({ contextTypes: ["TAB"] }).then((list) => Promise.all(list.filter((item) => new URL(item.documentUrl).pathname === ${JSON.stringify(OPTIONS_PATH)}).map((item) => chrome.tabs.remove(item.tabId)))).then(() => true)`;
const CONFIG_ACTION = `.notice[data-id="config"] .notice-action`;

test("侧边栏：没设置 AI 服务时点顶上那行的「打开设置」，设置页停在「AI 服务」一节；设置页开着、滚到底时再点一次也滚回那一节，不另开", async (ctx) => {
  await withVideo(ctx, async (panel, _from, tabId) => {
    await panel.evaluate(closeOptions);
    await waitIn(panel, "没设置的提示", `Boolean(document.querySelector(${JSON.stringify(CONFIG_ACTION)}))`);
    try {
      await tap(panel, CONFIG_ACTION);
      await waitIn(panel, "设置页停在 AI 服务", `(() => { const at = ${aiSectionAt}; return at !== null && at.top > -1 && at.top <= 200 && at.scrolled > 0 && at.hash === ""; })()`);

      // 设置页滚到底，回到视频页：侧边栏跟着当前标签页，回到视频才又有那一行。
      const away = await panel.evaluate(`(() => { const view = ${optionsView}; view.scrollTo(0, view.document.documentElement.scrollHeight); return view.document.getElementById("ai-service").getBoundingClientRect().top; })()`);
      assert.ok(away < 0, `滚到底以后 AI 服务一节在视口上面：${away}`);
      await panel.evaluate(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
      await waitIn(panel, "回到视频页又有那一行", `Boolean(document.querySelector(${JSON.stringify(CONFIG_ACTION)}))`);
      await tap(panel, CONFIG_ACTION);
      await waitIn(panel, "再点一次滚回 AI 服务", `(() => { const at = ${aiSectionAt}; return at !== null && at.top > -1 && at.top <= 200 && at.hash === ""; })()`);
      assert.equal(await panel.evaluate(`chrome.extension.getViews({ type: "tab" }).filter((view) => view.location.pathname === ${JSON.stringify(OPTIONS_PATH)}).length`), 1, "切回开着的设置页，不另开");

      // 「生成概览」位置上的「设置 AI 服务」也去同一节。
      await panel.evaluate(`(() => { const view = ${optionsView}; view.scrollTo(0, view.document.documentElement.scrollHeight); return true; })()`);
      await panel.evaluate(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
      await waitIn(panel, "回到视频页", `[...document.querySelectorAll(".ai-overview .button")].some((node) => node.textContent === "设置 AI 服务")`);
      assert.ok(await clickText(panel, ".ai-overview .button", "设置 AI 服务"));
      await waitIn(panel, "主按钮也滚回 AI 服务", `(() => { const at = ${aiSectionAt}; return at !== null && at.top > -1 && at.top <= 200 && at.hash === ""; })()`);
    } finally {
      await panel.evaluate(closeOptions);
    }
  });
});

test("侧边栏：配好过、密钥随浏览器重启清空时，顶上那行直说要重新填密钥、提一句记住密钥，主按钮写「重新填密钥」", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    // 存着服务商、模型和同意，会话里没有密钥：就是浏览器重启以后的样子。
    await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.remove(${JSON.stringify(API_KEY_SESSION_KEY)})]).then(() => true)`);
    try {
      const notice = textOf(`.notice[data-id="config"] .notice-text`);
      await waitIn(panel, "那一行改说重新填密钥", `${notice}.includes("API 密钥随浏览器重启或扩展更新清空了")`);
      assert.match(await panel.evaluate(notice), /要在设置页重新填；勾选「在这台电脑上记住密钥」就不用每次填/);
      await waitIn(panel, "主按钮改说重新填密钥", `[...document.querySelectorAll(".ai-overview .button")].some((node) => node.textContent === "重新填密钥")`);
    } finally {
      await panel.evaluate(`chrome.storage.local.set(${JSON.stringify(before)}).then(() => true)`);
      // 等后台和侧边栏都按还原后的设置重新问过，后面的测试一打开就是没设置的说法。
      await waitIn(panel, "还原后回到没设置的说法", `${textOf(`.notice[data-id="config"] .notice-text`)} === "字幕不用设置就能看；概览和问答要先设置 AI 服务"`);
    }
  });
});

const ASK_INPUT = ".dock .ask-entry input";
const qaAsked = (requests, since) => requests.some((entry) => entry.kind === "qa" && entry.at >= since);
const closeQaSheet = async (panel) => {
  await panel.evaluate(`(${qaSheet}).querySelector(".overlay-head [aria-label='关闭']").click(), true`);
  await waitIn(panel, "抽屉关上", `${qaSheet}?.open === false`);
};
/** 点进底下的提问框，输入这段字（空串就不输），按回车。 */
async function askFromDock(panel, text) {
  await panel.evaluate(`(document.querySelector(${JSON.stringify(ASK_INPUT)}).focus(), true)`);
  if (text) await panel.insertText(text);
  await panel.pressEnter();
}

test("侧边栏：底下的提问框没设置 AI 服务时按回车不发请求，字带进打开的问答抽屉，提问按钮的位置是「打开设置」、下面写明原因；关上抽屉焦点回到提问框", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    assert.equal(await panel.evaluate(`${qaSheet}?.open`), false);
    assert.deepEqual(await panel.evaluate(`(() => { const input = document.querySelector(${JSON.stringify(ASK_INPUT)}); return { label: input?.getAttribute("aria-label"), placeholder: input?.placeholder }; })()`), {
      label: "针对这个视频提问",
      placeholder: "针对这个视频提问，Enter 发送",
    });
    const since = Date.now();
    await askFromDock(panel, "页面测试想问的问题");
    await waitIn(panel, "问答抽屉打开", `${qaSheet}?.open === true`);
    await waitIn(panel, "问答的空状态", `${appText}.includes("还没有问答")`);
    assert.equal(await panel.evaluate(`document.querySelector(".qa-form input").value`), "页面测试想问的问题", "刚打的字带进抽屉");
    assert.deepEqual(
      await panel.evaluate(`(() => { const button = document.querySelector(".qa-form .button"); return { text: button?.textContent, disabled: button?.disabled }; })()`),
      { text: "打开设置", disabled: false },
    );
    assert.ok((await panel.evaluate(textOf(".qa-form .control-note"))).includes("先在设置页设置 AI 服务"), "原因写在「打开设置」下面");
    assert.equal(await panel.evaluate(`document.activeElement === document.querySelector(".qa-form input")`), true, `打开抽屉以后焦点在抽屉里的提问框：${JSON.stringify(await panel.focused())}`);
    assert.ok(await stillFalse(async () => qaAsked(ctx.requests, since) || (await panel.evaluate(`document.querySelectorAll(".qa-entry").length > 0`)), 20), "不能问时不发问答请求");
    assert.deepEqual(await panel.evaluate(modes), SKIM, "开抽屉不切模式");
    await closeQaSheet(panel);
    assert.equal(await panel.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(ASK_INPUT)})`), true, "关上以后焦点回到底下的提问框");
    assert.equal(await panel.evaluate(`document.querySelector(${JSON.stringify(ASK_INPUT)}).value`), "页面测试想问的问题", "没发出去的字留着");
  });
});

test("侧边栏：设置好 AI 服务以后，底下的提问框空着回车和点「问答记录」只打开抽屉；打字回车发出问题、清空提问框，答案在抽屉里", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
    try {
      await waitIn(panel, "设置好了，生成概览能点", `[...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览" && !node.disabled)`);
      const since = Date.now();
      await askFromDock(panel, "");
      await waitIn(panel, "空着回车打开问答抽屉", `${qaSheet}?.open === true`);
      await closeQaSheet(panel);
      await tap(panel, ".dock [aria-label='问答记录']");
      await waitIn(panel, "点「问答记录」打开问答抽屉", `${qaSheet}?.open === true`);
      await closeQaSheet(panel);
      assert.ok(await stillFalse(async () => qaAsked(ctx.requests, since) || (await panel.evaluate(`document.querySelectorAll(".qa-entry").length > 0`)), 20), "只打开抽屉，不发问答请求");

      await askFromDock(panel, "页面测试从底下问的");
      await until("模拟服务收到问答请求", () => qaAsked(ctx.requests, since)).catch(async (error) => {
        throw new Error(`${error.message}\n抽屉里显示：${await panel.evaluate(`(${qaSheet})?.innerText ?? ""`)}`);
      });
      await waitIn(panel, "答案在抽屉里", `${textOf(".qa-entry .qa-answer")}.includes("模拟服务的回答")`, 20_000);
      assert.ok((await panel.evaluate(textOf(".qa-entry .qa-question"))).includes("页面测试从底下问的"));
      assert.equal(await panel.evaluate(`document.querySelector(${JSON.stringify(ASK_INPUT)}).value`), "", "发出去以后清空");
      await closeQaSheet(panel);
      assert.equal(await panel.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(ASK_INPUT)})`), true, "关上以后焦点回到底下的提问框");
    } finally {
      const ids = await panel.evaluate(`[...document.querySelectorAll(".qa-entry[data-id]")].map((node) => node.dataset.id)`);
      if (ids.length) await editDatabase(panel, {}, { qa: ids });
      await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify(before)}), chrome.storage.session.remove(${JSON.stringify(API_KEY_SESSION_KEY)})]).then(() => true)`);
      await waitIn(panel, "还原后回到没设置的说法", `${textOf(`.notice[data-id="config"] .notice-text`)} === "字幕不用设置就能看；概览和问答要先设置 AI 服务"`);
    }
  });
});

test("侧边栏：头部的笔记按钮打开笔记层，列出本视频的笔记，能复制正文和链接，能改能删，删完回到空状态", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await tap(panel, ".mode-row [aria-label='笔记']");
    await waitIn(panel, "笔记层打开", `document.querySelector(".layer")?.open === true`);
    await waitIn(panel, "笔记的空状态", `${appText}.includes("还没有笔记")`);
    const saved = await panel.evaluate(`chrome.runtime.sendMessage({ type: "notes.save", req: { video: ${JSON.stringify(VIDEO)}, atSec: 1, text: "页面测试记的一条" } })`);
    assert.equal(saved?.ok, true, JSON.stringify(saved));
    await waitIn(panel, "列出这条", `${textOf(".note-text")} === "页面测试记的一条"`);
    assert.equal(await panel.evaluate(textOf(".layer .toolbar-count")), "1 条");

    await panel.evaluate(recordClipboard);
    await tap(panel, ".note .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "复制正文"));
    await waitIn(panel, "复制了正文", `${copiedTexts}.length === 1`);
    assert.equal((await panel.evaluate(copiedTexts))[0], "页面测试记的一条");
    await waitIn(panel, "层里说已复制", copiedSaid);
    await tap(panel, ".note .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "复制链接"));
    await waitIn(panel, "复制了链接", `${copiedTexts}.length === 2`);
    const link = (await panel.evaluate(copiedTexts))[1];
    assert.ok(link.startsWith("http") && link.includes(FIRST_ID), `复制的是这条笔记的视频链接：${link}`);

    await tap(panel, ".note .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "编辑"));
    await waitIn(panel, "编辑框", `Boolean(document.querySelector(".note-input"))`);
    await panel.evaluate(`(() => { const input = document.querySelector(".note-input"); input.value = "改过的笔记"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.ok(await clickText(panel, ".note-edit .button", "保存"));
    await waitIn(panel, "改好了", `${textOf(".note-text")} === "改过的笔记"`);

    await tap(panel, ".note .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "删除"));
    await waitIn(panel, "删完回到空状态", `${appText}.includes("还没有笔记")`);
    assert.equal(await panel.evaluate(textOf(".layer .layer-toast")), "已删除这条笔记", "层盖住了顶上那一行，结果在层里说");
    await tap(panel, ".layer [aria-label='返回']");
    await waitIn(panel, "笔记层关上", `document.querySelector(".layer")?.open === false`);
  });
});

/**
 * 删掉列表里的一条以前装上记录：那一条什么时候标上离场、是不是点不到、哪一帧真正拿掉，下面那一条每一帧在哪。
 * 按帧数记，不按毫秒，看得出离场是不是走了好几帧、拿掉的那一下下面的有没有跳。
 */
const watchExit = (listSelector, rowSelector) => `(() => {
  const list = document.querySelector(${JSON.stringify(listSelector)});
  const target = list.querySelector(${JSON.stringify(rowSelector)});
  const below = target.nextElementSibling;
  const log = { index: [...list.children].indexOf(target), height: target.getBoundingClientRect().height, marked: null, inert: null, gone: null, tops: [], deltas: [] };
  let frame = 0;
  let last = performance.now();
  const tick = (now) => {
    log.deltas.push(now - last);
    last = now;
    frame += 1;
    if (below) log.tops.push(below.getBoundingClientRect().top);
    if (log.gone === null || frame < log.gone + 3) requestAnimationFrame(tick);
    else log.done = true;
  };
  if (below) log.tops.push(below.getBoundingClientRect().top);
  requestAnimationFrame(tick);
  new MutationObserver((records) => {
    for (const record of records) {
      if (log.marked === null && record.type === "attributes" && record.target === target) {
        log.marked = frame;
        log.inert = target.inert;
        log.kept = [...list.children].indexOf(target) === log.index;
      }
    }
    if (log.gone === null && !target.isConnected) log.gone = frame;
  }).observe(list, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-leaving"] });
  window.exitLog = log;
  return true;
})()`;

test("侧边栏：笔记层里删掉一条，那一条留在原位淡掉、收起，点不到，下面的跟着平滑上移，走完才拿掉；系统设了减少动态效果时当场拿掉", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const send = (type, req) => panel.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);
    const listed = `chrome.runtime.sendMessage({ type: "notes.list", req: { video: ${JSON.stringify(VIDEO)} } }).then((reply) => reply.value.notes)`;
    const before = await panel.evaluate(listed);
    const COUNT = 40;
    try {
      for (let index = 0; index < COUNT; index += 1) {
        const saved = await send("notes.save", { video: VIDEO, atSec: index + 1, text: `页面测试的长列表第 ${index + 1} 条` });
        assert.equal(saved?.ok, true, JSON.stringify(saved));
      }
      await tap(panel, ".mode-row [aria-label='笔记']");
      await waitIn(panel, "笔记层打开", `document.querySelector(".layer")?.open === true`);
      await waitIn(panel, "列出全部", `document.querySelectorAll(".layer .note-list > .note").length === ${COUNT}`);
      // 层的进场走完再删，量到的是删除这一下。
      await panel.evaluate(`Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))).then(() => true)`);

      const deleteSecond = async () => {
        const id = await panel.evaluate(`document.querySelectorAll(".layer .note-list > .note")[1].dataset.id`);
        await panel.evaluate(watchExit(".layer .note-list", `.note[data-id="${id}"]`));
        await panel.evaluate(`document.querySelectorAll(".layer .note-list > .note")[1].querySelector(".menu-anchor button").click(), true`);
        // 每一条都带着自己的菜单，点开着的那一个里的「删除」。
        assert.ok(await clickText(panel, ".menu:popover-open .menu-item", "删除"));
        await panel.waitFor("拿掉以后又过了几帧", `window.exitLog.done === true`).catch(async (error) => {
          const log = await panel.evaluate(`JSON.stringify({ ...window.exitLog, tops: window.exitLog.tops.length, deltas: window.exitLog.deltas.length, leaving: [...document.querySelectorAll(".note[data-leaving]")].map((node) => node.dataset.id), hidden: document.hidden })`);
          throw new Error(`${error.message}\n${log}`);
        });
        await waitIn(panel, "说删掉了", `document.querySelector(".layer .layer-toast")?.textContent === "已删除这条笔记"`);
        return panel.evaluate(`window.exitLog`);
      };

      const moving = await deleteSecond();
      assert.notEqual(moving.marked, null, "删之前先标上离场");
      assert.equal(moving.inert, true, "离场途中点不到");
      assert.equal(moving.kept, true, "离场途中还在原来的位置");
      assert.ok(moving.gone - moving.marked >= 3, `离场走了好几帧才拿掉：第 ${moving.marked} 帧标上，第 ${moving.gone} 帧拿掉`);
      const tops = moving.tops;
      const moved = tops[0] - tops[tops.length - 1];
      const gap = await panel.evaluate(`parseFloat(getComputedStyle(document.querySelector(".layer .note-list")).rowGap)`);
      assert.ok(Math.abs(moved - (moving.height + gap)) < 1, `下面那一条顶上来一条加一道缝那么高：${moved} 对 ${moving.height} + ${gap}`);
      assert.ok(tops.every((top, index) => index === 0 || top <= tops[index - 1] + 0.5), `一路往上走，不往回弹：${tops.join(", ")}`);
      const step = tops.slice(1).map((top, index) => tops[index] - top);
      assert.ok(Math.max(...step) < moved, `分几帧走完，不是一下子跳上去：${step.join(", ")}`);
      assert.ok(Math.abs(tops[moving.gone + 1] - tops[moving.gone]) < 1, `真正拿掉的那一帧下面的不再跳：${tops.join(", ")}`);
      await waitIn(panel, "少了一条", `document.querySelectorAll(".layer .note-list > .note").length === ${COUNT - 1}`);

      await panel.setReducedMotion(true);
      const instant = await deleteSecond();
      assert.ok(instant.marked === null || instant.gone === instant.marked, `减少动态效果时当场拿掉，不留一帧：第 ${instant.marked} 帧标上，第 ${instant.gone} 帧拿掉`);
      await waitIn(panel, "又少了一条", `document.querySelectorAll(".layer .note-list > .note").length === ${COUNT - 2}`);
    } finally {
      await panel.setReducedMotion(false);
      const added = (await panel.evaluate(listed)).filter((row) => !before.some((old) => old.id === row.id));
      for (const row of added) await send("notes.delete", { id: row.id });
      await panel.evaluate(`(document.querySelector(".layer [aria-label='返回']")?.click(), true)`);
    }
  });
});

/** 在扩展页面里直接改本机数据库：放进或删掉记录，测试做完自己收拾。 */
const editDatabase = (page, puts, deletes = {}) =>
  page.evaluate(`(async () => {
    const db = await new Promise((done, failed) => { const open = indexedDB.open(${JSON.stringify(DATABASE_NAME)}); open.onsuccess = () => done(open.result); open.onerror = () => failed(open.error); });
    const puts = ${JSON.stringify(puts)};
    const deletes = ${JSON.stringify(deletes)};
    const tx = db.transaction([...new Set([...Object.keys(puts), ...Object.keys(deletes)])], "readwrite");
    for (const [store, rows] of Object.entries(puts)) for (const row of rows) tx.objectStore(store).put(row);
    for (const [store, keys] of Object.entries(deletes)) for (const key of keys) tx.objectStore(store).delete(key);
    await new Promise((done, failed) => { tx.oncomplete = done; tx.onerror = () => failed(tx.error); });
    db.close();
    return true;
  })()`);

test("侧边栏：搜索笔记时标出正文和引文里的关键词，全部笔记还显示并标出视频标题和作者", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const note = {
    id: "note_page_search", kind: "note", origin: "user", video: VIDEO, atSec: 5, createdAt: 1, updatedAt: 1,
    snapshot: { title: "航线 Atlas", author: "Atlas 读书会" }, text: "翻到 ATLAS 的目录", quote: "小册子叫 atlas",
  };
  await editDatabase(from, { notes: [note] });
  try {
    await withVideo(ctx, async (panel) => {
      await waitIn(panel, "笔记按钮出现", `Boolean(document.querySelector(".mode-row [aria-label='笔记']"))`);
      await tap(panel, ".mode-row [aria-label='笔记']");
      await waitIn(panel, "本视频的笔记", `${textOf(".note-text")} === ${JSON.stringify(note.text)}`);
      assert.equal(await panel.evaluate('document.querySelector(".note .note-video, .note .note-author") === null'), true);
      await panel.evaluate(`(() => { const input = document.querySelector(".notes .search-input"); input.value = "atlas"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await waitIn(panel, "本视频的笔记正文和引文标出关键词", `${textOf(".note mark")} === "ATLAS\\natlas"`);

      await waitIn(panel, "全部范围出现", `[...document.querySelectorAll(".notes .segment")].some((node) => node.textContent === "全部")`);
      assert.ok(await clickText(panel, ".notes .segment", "全部"));
      await waitIn(panel, "全部笔记显示作者", `${textOf(".note-author")} === ${JSON.stringify(note.snapshot.author)}`);
      assert.equal(await panel.evaluate(textOf(".note-video")), note.snapshot.title);
      assert.equal(await panel.evaluate(textOf(".note-video mark")), "Atlas");
      assert.equal(await panel.evaluate(textOf(".note-author mark")), "Atlas");
      await panel.evaluate(`(() => { const input = document.querySelector(".notes .search-input"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await waitIn(panel, "清空搜索后还显示笔记，高亮消失", `Boolean(document.querySelector(".note-text")) && !document.querySelector(".note mark")`);
    });
  } finally {
    await editDatabase(from, {}, { notes: [note.id] });
  }
});

const STALE_SRT = "1\n00:00:01,000 --> 00:00:04,000\n换过的样例字幕一\n\n2\n00:00:05,000 --> 00:00:08,000\n换过的样例字幕二\n";
const STALE_QA_ID = "qa_page-test-stale";
const SWITCH_QA_ID = "qa_page-test-switch";


test("侧边栏：换了字幕以后，依据原来那份字幕的结论和问答标「基于旧字幕」，内容照旧；换之前不标", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const panel = await ctx.openSidePanel(from);
  const send = (type, req) => panel.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);
  // 同一个视频在新标签页里打开，再关掉旧的：侧边栏直接跟过去，重读本机。
  const reopen = async (tabId) => {
    const next = await openTab(panel, watchPage(FIRST_ID));
    if (tabId !== null) await closeTab(from, tabId);
    await waitIn(panel, "字幕读到", `Boolean(document.querySelector(".modes")) && ${appText}.includes(${JSON.stringify(FIRST_TITLE)})`);
    return next;
  };
  const askedSheet = async () => {
    await tap(panel, ".dock [aria-label='问答记录']");
    await waitIn(panel, "问答里列出那一条", `${textOf(".qa-entry .qa-question")}.includes("页面测试的问题")`);
  };
  const closeSheet = async () => {
    await panel.evaluate(`(${qaSheet}).querySelector(".overlay-head [aria-label='关闭']").click(), true`);
    await waitIn(panel, "抽屉关上", `${qaSheet}?.open === false`);
  };
  let tabId = await reopen(null);
  try {
    const read = await send("transcript.get", { video: VIDEO, mode: "cache-only" });
    assert.equal(read?.ok, true, JSON.stringify(read).slice(0, 200));
    const ref = read.value.transcript.ref;
    const derived = { basis: { source: "transcript", transcript: ref }, gen: { feature: "analysis", promptVersion: "p", model: "sample-model", effort: "off" } };
    const part = { derived, taskCreatedAt: 1 };
    const overview = {
      schemaVersion: 1,
      videoKey: VIDEO,
      snapshot: { title: FIRST_TITLE, author: "" },
      analysis: { chapters: [{ title: "页面测试的章节", timestamp: "0:00", timestampSeconds: 0, summary: "" }], keyQuotes: [], verdict: { verdict: "可以看", summary: "页面测试的结论" } },
      parts: { chapters: part, verdict: part },
      updatedAt: 1,
    };
    const qa = { id: STALE_QA_ID, video: VIDEO, question: "页面测试的问题", answer: "页面测试的回答", citations: [], clickable: [], derived, createdAt: 1 };
    await editDatabase(panel, { overviews: [overview], qa: [qa] });

    // 同一份字幕：结论和问答都不标。
    tabId = await reopen(tabId);
    await waitIn(panel, "结论摆出来", `${textOf(".verdict-text")} === "页面测试的结论"`);
    assert.doesNotMatch(await panel.evaluate(appText), /基于旧字幕/);
    await askedSheet();
    assert.doesNotMatch(await panel.evaluate(textOf(".qa-entry")), /基于旧字幕/);
    await closeSheet();

    // 导入字幕文件，换成另一份：结论块和那条问答标出来，结论、章节和回答都还在。
    const imported = await send("imports.add", { video: VIDEO, fileName: "换过的样例.srt", text: STALE_SRT });
    assert.equal(imported?.ok, true, JSON.stringify(imported));
    tabId = await reopen(tabId);
    await waitIn(panel, "结论块标基于旧字幕", `${textOf(".verdict .verdict-basis")}.includes("基于旧字幕")`);
    assert.equal(await panel.evaluate(textOf(".verdict-text")), "页面测试的结论", "结论不删不改");
    assert.ok((await panel.evaluate(textOf(".chapter-list"))).includes("页面测试的章节"), "章节照旧");
    const now = await send("transcript.get", { video: VIDEO, mode: "cache-only" });
    assert.equal(now?.value?.transcript?.ref?.kind, "imported", "侧边栏用的是导入的那份");
    assert.equal(await panel.evaluate(`(${appText}.match(/基于旧字幕/g) ?? []).length`), 1, "章节和结论同一份依据，只在结论块里标一次");
    await askedSheet();
    await waitIn(panel, "问答标基于旧字幕", `${textOf(".qa-entry")}.includes("基于旧字幕")`);
    assert.ok((await panel.evaluate(textOf(".qa-answer"))).includes("页面测试的回答"), "回答照旧");
    await closeSheet();
  } finally {
    // 收拾干净：后面的测试打开同一个视频时要的是没有概览、用平台字幕的样子。
    await send("imports.remove", { video: VIDEO });
    await editDatabase(panel, {}, { overviews: [VIDEO], qa: [STALE_QA_ID] });
    await closeTab(from, tabId);
    const left = await send("overview.get", { video: VIDEO });
    assert.equal(left?.value?.overview, undefined, "放进去的概览删掉了");
  }
});

test("侧边栏：同一个视频换到另一个标签页，重读本机的概览和问答：别处写进来、没发通知的这时看得到", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const panel = await ctx.openSidePanel(from);
  const tabs = [await openTab(panel, watchPage(FIRST_ID))];
  try {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const derived = { basis: { source: "legacy-unknown" } };
    const overview = {
      schemaVersion: 1,
      videoKey: VIDEO,
      snapshot: { title: FIRST_TITLE, author: "" },
      analysis: { chapters: [{ title: "别处写的章节", timestamp: "0:00", timestampSeconds: 0, summary: "" }], keyQuotes: [], verdict: { verdict: "可以看", summary: "别处写的结论" } },
      updatedAt: 1,
    };
    const qa = { id: SWITCH_QA_ID, video: VIDEO, question: "别处问的问题", answer: "别处的回答", citations: [], clickable: [], derived, createdAt: 1 };
    // 直接写进本机数据库，不发通知：就像别的窗口问过、侧边栏没收到的样子。
    await editDatabase(panel, { overviews: [overview], qa: [qa] });
    assert.equal(await panel.evaluate(`Boolean(document.querySelector(".verdict-text"))`), false, "刚写进去，侧边栏还没读过");

    tabs.push(await openTab(panel, watchPage(FIRST_ID)));
    await waitIn(panel, "换过去以后结论摆出来", `${textOf(".verdict-text")} === "别处写的结论"`);
    assert.ok((await panel.evaluate(textOf(".chapter-list"))).includes("别处写的章节"));
    await tap(panel, ".dock [aria-label='问答记录']");
    await waitIn(panel, "问答里有别处问的那一条", `${textOf(".qa-entry .qa-question")}.includes("别处问的问题")`);
    await panel.evaluate(`(${qaSheet}).querySelector(".overlay-head [aria-label='关闭']").click(), true`);
    await waitIn(panel, "抽屉关上", `${qaSheet}?.open === false`);
  } finally {
    await editDatabase(panel, {}, { overviews: [VIDEO], qa: [SWITCH_QA_ID] });
    for (const tabId of tabs) await closeTab(from, tabId);
  }
});

const COPY_QA_ID = "qa_page-test-copy";

test("侧边栏：问答的「⋯」菜单里「复制回答」复制回答，时间点按 [分:秒] 写回去，抽屉里说一声已复制；「删除」写着删了找不回来，删完说一声", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const panel = await ctx.openSidePanel(from);
  let tabId = null;
  try {
    const answer = "页面测试的回答 [0:02]，依据在 [0:01-0:03]。";
    const qa = { id: COPY_QA_ID, video: VIDEO, question: "页面测试的复制问题", answer, citations: [], clickable: [2], derived: { basis: { source: "legacy-unknown" } }, createdAt: 1 };
    await editDatabase(panel, { qa: [qa] });
    tabId = await openTab(panel, watchPage(FIRST_ID));
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await panel.evaluate(recordClipboard);

    await tap(panel, ".dock [aria-label='问答记录']");
    await waitIn(panel, "问答里列出那一条", `${textOf(".qa-entry .qa-question")}.includes("页面测试的复制问题")`);
    await tap(panel, ".qa-entry .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "复制回答"));
    await waitIn(panel, "复制了回答", `${copiedTexts}.length === 1`);
    assert.equal((await panel.evaluate(copiedTexts))[0], answer, "时间点带回方括号，和存着的回答一字不差");
    await waitIn(panel, "说已复制", copiedSaid);
    assert.equal(await panel.evaluate(`(${qaSheet}).querySelector(".layer-toast")?.textContent`), "已复制", "抽屉盖住了顶上那一行，在抽屉里说");

    await tap(panel, ".qa-entry .menu-anchor button");
    await waitIn(panel, "删除带着提醒", `[...document.querySelectorAll(".menu-item")].some((item) => item.textContent.includes("删除") && item.textContent.includes("删了找不回来"))`);
    assert.ok(await clickText(panel, ".menu-item", "删除"));
    await waitIn(panel, "那一条没了", `!document.querySelector(".qa-entry[data-id='${COPY_QA_ID}']")`);
    await waitIn(panel, "说删掉了", `(${qaSheet}).querySelector(".layer-toast")?.textContent === "已删除这条问答"`);
    await panel.evaluate(`(${qaSheet}).querySelector(".overlay-head [aria-label='关闭']").click(), true`);
    await waitIn(panel, "抽屉关上", `${qaSheet}?.open === false`);
  } finally {
    await editDatabase(panel, {}, { qa: [COPY_QA_ID] });
    if (tabId !== null) await closeTab(from, tabId);
  }
});

test("侧边栏：结论带着标题译名时顶上的标题显示译名、悬停是原标题；没有译名的旧结论照旧显示原标题", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const panel = await ctx.openSidePanel(from);
  const heading = `[document.querySelector(".video-title")?.textContent ?? "", document.querySelector(".video-title")?.getAttribute("title") ?? ""]`;
  // 新标签页里结论从本机先到，视频信息读到之前原标题还是标签页标题，所以等标题和悬停都换好再核对。
  const headingIs = (shown, hover) => `((pair) => pair[0] === ${JSON.stringify(shown)} && pair[1] === ${JSON.stringify(hover)})(${heading})`;
  const tabs = [];
  /** 把这份结论写进本机，再在新标签页里打开同一个视频，侧边栏跟过去重读。 */
  const showWith = async (verdict, label) => {
    const overview = {
      schemaVersion: 1,
      videoKey: VIDEO,
      snapshot: { title: FIRST_TITLE, author: "" },
      analysis: { chapters: [{ title: "页面测试的章节", timestamp: "0:00", timestampSeconds: 0, summary: "" }], keyQuotes: [], verdict },
      updatedAt: 1,
    };
    await editDatabase(panel, { overviews: [overview] });
    tabs.push(await openTab(panel, watchPage(FIRST_ID)));
    await waitIn(panel, label, `${textOf(".verdict-text")} === ${JSON.stringify(verdict.summary)}`);
  };
  try {
    tabs.push(await openTab(panel, watchPage(FIRST_ID)));
    await waitIn(panel, "字幕读到，还没有概览", `${textOf(".video-title")} === ${JSON.stringify(FIRST_TITLE)}`);
    assert.deepEqual(await panel.evaluate(heading), [FIRST_TITLE, FIRST_TITLE], "还没有概览时是原标题");

    await showWith({ verdict: "可以看", summary: "带译名的结论", translatedTitle: "A Long Sample Video" }, "带译名的结论摆出来");
    await waitIn(panel, "标题换成译名，悬停是原标题", headingIs("A Long Sample Video", FIRST_TITLE));
    assert.deepEqual(await panel.evaluate(heading), ["A Long Sample Video", FIRST_TITLE], "标题是译名，悬停是原标题");

    await showWith({ verdict: "可以看", summary: "旧版的结论" }, "没有译名的结论摆出来");
    await waitIn(panel, "标题和悬停都是原标题", headingIs(FIRST_TITLE, FIRST_TITLE));
    assert.deepEqual(await panel.evaluate(heading), [FIRST_TITLE, FIRST_TITLE], "旧结论没有译名，照旧是原标题");
  } finally {
    await editDatabase(panel, {}, { overviews: [VIDEO] });
    for (const tabId of tabs) await closeTab(from, tabId);
  }
});

test("侧边栏：结论带着评论区时，章节下面摆「评论区」一块，口碑标签加一句话，要点点开露出原评论；评论的标记写在章节旁边", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const panel = await ctx.openSidePanel(from);
  const tabs = [];
  const comments = {
    tag: "有人指出错误",
    line: "页面测试的评论区一句话",
    points: [{ text: "页面测试的要点", quotes: [{ text: "页面测试的原评论", likes: 230, pinned: true }] }],
    marks: [{ start: 0, kind: "有误" }],
  };
  const overview = {
    schemaVersion: 1,
    videoKey: VIDEO,
    snapshot: { title: FIRST_TITLE, author: "" },
    analysis: { chapters: [{ title: "页面测试的章节", timestamp: "0:00", timestampSeconds: 0, summary: "" }], keyQuotes: [], verdict: { verdict: "可以看", summary: "带评论区的结论", comments } },
    updatedAt: 1,
  };
  try {
    await editDatabase(panel, { overviews: [overview] });
    tabs.push(await openTab(panel, watchPage(FIRST_ID)));
    await waitIn(panel, "评论区摆出来", `${textOf(".comment-block .comment-line")}.includes("页面测试的评论区一句话")`);
    const shown = await panel.evaluate(`({
      tag: document.querySelector(".comment-block .badge")?.textContent ?? "",
      note: document.querySelector(".chapter-note")?.textContent ?? "",
      open: document.querySelector(".comment-point")?.open ?? null,
      count: document.querySelector(".comment-count")?.textContent ?? "",
    })`);
    assert.deepEqual(shown, { tag: "有人指出错误", note: "评论说有误", open: false, count: "1 条评论" }, "原评论默认收着");
    await panel.evaluate(`(document.querySelector(".comment-point summary").click(), true)`);
    await waitIn(panel, "点开露出原评论", `${textOf(".comment-quote-text")} === "页面测试的原评论"`);
    assert.equal(await panel.evaluate(`document.querySelector(".comment-quote-meta")?.textContent ?? ""`), "置顶 · 赞 230");
  } finally {
    await editDatabase(panel, {}, { overviews: [VIDEO] });
    for (const tabId of tabs) await closeTab(from, tabId);
  }
});

test("侧边栏：没设置 AI 服务时不摆本窗口全部生成；设置好以后它在「生成概览」那排按钮里，清点时回到速读最上面写清几个视频、要新生成几个，取消回到那排按钮", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const batchButton = `[...document.querySelectorAll(".ai-overview .state-actions .batch-start .button")].find((node) => node.textContent.startsWith("本窗口全部生成"))`;
    await waitIn(panel, "没设置时的主按钮", `[...document.querySelectorAll(".ai-overview .button")].some((node) => node.textContent === "设置 AI 服务")`);
    assert.equal(await panel.evaluate(`Boolean(${batchButton})`), false, "没设置时不摆");

    // 只在这个测试里配好模型服务，做完还原，后面的测试照旧是没设置的样子。
    const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
    try {
      await waitIn(panel, "批量按钮能点", `${batchButton}?.disabled === false`);
      assert.equal(await panel.evaluate(`(${batchButton}).dataset.variant`), "text", "和导出学习稿一个样子");
      await panel.evaluate(`(${batchButton}).click(), true`);
      await waitIn(panel, "清点完给出确认", `${textOf(".batch-bar .batch-status")} === "本窗口有 1 个视频，要新生成 1 个。"`);
      assert.equal(await panel.evaluate(`document.querySelector(".skim").firstElementChild?.matches(".batch-bar")`), true, "确认时在速读最上面");
      assert.equal(await panel.evaluate(`Boolean(${batchButton})`), false, "那排按钮里先不摆");
      assert.match(await panel.evaluate(textOf(".batch-bar .batch-notice")), /会用掉 API 额度/);
      assert.ok(await panel.evaluate(`[...document.querySelectorAll(".batch-bar .button")].some((node) => node.textContent === "开始生成 1 个")`), "确认按钮写着要生成几个");
      // 不真的开始：生成、停止和重开接上在端到端里走。
      assert.ok(await clickText(panel, ".batch-bar .button", "取消"));
      await waitIn(panel, "取消以后回到按钮", `Boolean(${batchButton})`);
    } finally {
      await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify(before)}), chrome.storage.session.remove(${JSON.stringify(API_KEY_SESSION_KEY)})]).then(() => true)`);
    }
  });
});

test("侧边栏：打开就出结论因为额度用完停着时，顶上一行说停了、给「恢复」，点了就恢复；再停一次，关掉开关以后这一行也消失", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    // 点「恢复」以后后台会把开着的视频页过一遍：门槛调到最高，这个 30 分钟的视频不会真的生成。
    const settings = { ...stored.local[SETTINGS_STORAGE_KEY], autoOverview: true, autoOverviewMinutes: 180 };
    const paused = { tried: [], sent: [], paused: { reason: "quota", at: Date.now() } };
    const setLocal = (value) => panel.evaluate(`chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: value })}).then(() => true)`);
    // 先打开开关（开关一动后台就清掉暂停），再放一份停着的记录，然后改一项别的设置让侧边栏重问配置。
    await panel.evaluate(`chrome.storage.session.set(${JSON.stringify(stored.session)}).then(() => true)`);
    await setLocal(settings);
    try {
      await waitIn(panel, "配置齐了", `!${textOf(".notice-text")}.includes("要先设置 AI 服务")`);
      await panel.evaluate(`chrome.storage.session.set(${JSON.stringify({ [AUTO_LEDGER_KEY]: paused })}).then(() => true)`);
      await setLocal({ ...settings, analysisChunkMode: "short" });
      const pausedLine = `.notice[data-id="auto-paused"]`;
      await waitIn(panel, "暂停的提示", `${textOf(pausedLine + " .notice-text")} === "额度用完了，「打开就出结论」先停了"`);
      assert.equal(await panel.evaluate(textOf(pausedLine + " .notice-action")), "恢复");
      // 点「恢复」：后台恢复，告诉页面以后这一行消失。
      await tap(panel, pausedLine + " .notice-action");
      await waitIn(panel, "点了恢复，提示消失", `!document.querySelector(${JSON.stringify(pausedLine)})`);
      await waitIn(panel, "后台的暂停记录清掉了", `chrome.storage.session.get(${JSON.stringify(AUTO_LEDGER_KEY)}).then((items) => !items[${JSON.stringify(AUTO_LEDGER_KEY)}]?.paused)`);

      // 再停一次，关掉开关：后台同样从暂停里恢复，这一行消失。
      await panel.evaluate(`chrome.storage.session.set(${JSON.stringify({ [AUTO_LEDGER_KEY]: paused })}).then(() => true)`);
      await setLocal({ ...settings, analysisChunkMode: "long" });
      await waitIn(panel, "又停了", `Boolean(document.querySelector(${JSON.stringify(pausedLine)}))`);
      await setLocal({ ...settings, analysisChunkMode: "long", autoOverview: false });
      await waitIn(panel, "提示消失", `!document.querySelector(${JSON.stringify(pausedLine)})`);
      const ledger = await panel.evaluate(`chrome.storage.session.get(${JSON.stringify(AUTO_LEDGER_KEY)})`);
      assert.equal(ledger[AUTO_LEDGER_KEY]?.paused, undefined);
    } finally {
      await panel.evaluate(
        `Promise.all([chrome.storage.local.set(${JSON.stringify(before)}), chrome.storage.session.remove([${JSON.stringify(API_KEY_SESSION_KEY)}, ${JSON.stringify(AUTO_LEDGER_KEY)}])]).then(() => true)`,
      );
    }
  });
});

// 服务的原话里故意带一段标记：页面只能把它当文字显示。
const RETIRED_SAID = 'The model sample-old is no longer available to new users. Use sample-new instead. <a href="https://example.com/x">details</a> <img src=x onerror="alert(1)">';
const WRONG_KEY = "sk-test-wrongkey0000aaaa1111bbbb";
const GOOD_KEY = "sk-test-goodkey2222cccc3333dddd";

/** 本机的 OpenAI 兼容服务：错的密钥回 401 并回显半截密钥（有的服务就这样），对的密钥回 404 说型号下线了。 */
async function startRefusingService() {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const wrong = String(req.headers.authorization ?? "").includes(WRONG_KEY);
      res.writeHead(wrong ? 401 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: wrong ? `Incorrect API key provided: ${WRONG_KEY.slice(0, 11)}****${WRONG_KEY.slice(-4)}.` : RETIRED_SAID } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    base: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}

test("侧边栏：模型服务回了带说明的报错时，三段式下面有一行默认收着的「服务的原话」，展开是纯文本；密钥不对时不带原话，看不到密钥", async (ctx) => {
  const service = await startRefusingService();
  try {
    await withVideo(ctx, async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
      const configure = async (key) => {
        const stored = await storedSettings({ presetId: "custom", key, model: "sample-old", fields: { protocol: "openai", aiBaseUrl: service.base } });
        await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
      };
      const generateButton = `[...document.querySelectorAll(".button")].find((node) => node.textContent === "生成概览")`;
      const generate = async (label) => {
        await waitIn(panel, `${label}：生成概览能点`, `${generateButton}?.disabled === false`);
        await panel.evaluate(`(${generateButton}).click(), true`);
        await waitIn(panel, `${label}：报错`, `Boolean(document.querySelector(".error-line"))`, 20_000);
      };
      try {
        await configure(WRONG_KEY);
        await generate("密钥不对");
        assert.equal(await panel.evaluate(textOf(".error-line")), errorCopy("INVALID_AI_KEY").cause + errorCopy("INVALID_AI_KEY").impact + errorCopy("INVALID_AI_KEY").next);
        assert.equal(await panel.evaluate(`document.querySelectorAll(".service-said").length`), 0, "鉴权失败不带原话");
        const shown = await panel.evaluate(`document.documentElement.innerHTML`);
        for (const piece of [WRONG_KEY.slice(0, 11), WRONG_KEY.slice(-4)]) assert.ok(!shown.includes(piece), `页面上出现了密钥的片段 ${piece}`);

        await configure(GOOD_KEY);
        await generate("型号下线");
        await waitIn(panel, "原话那一行", `Boolean(document.querySelector(".service-said"))`);
        const said = await panel.evaluate(`(() => {
          const details = document.querySelector(".service-said");
          // 收起的 details 里，新版 Chrome 照样排版、只是不画，看得见与否用 checkVisibility 判断。
          const before = { open: details.open, visible: details.querySelector(".service-said-text").checkVisibility() };
          details.open = true;
          const text = details.querySelector(".service-said-text");
          return {
            before,
            summary: details.querySelector("summary")?.textContent,
            visible: text.checkVisibility(),
            text: text.textContent,
            elements: text.querySelectorAll("*").length,
            links: details.querySelectorAll("a, img").length,
          };
        })()`);
        assert.deepEqual(said.before, { open: false, visible: false }, "默认收着");
        assert.equal(said.summary, "服务的原话");
        assert.equal(said.visible, true, "点开以后看得到");
        assert.equal(said.text, RETIRED_SAID, "原样当文字显示");
        assert.equal(said.elements, 0, "原话里的标记没有变成元素");
        assert.equal(said.links, 0);
        assert.equal(await panel.evaluate(textOf(".error-line")), errorCopy("MODEL_OR_ENDPOINT_NOT_FOUND").cause + errorCopy("MODEL_OR_ENDPOINT_NOT_FOUND").impact + errorCopy("MODEL_OR_ENDPOINT_NOT_FOUND").next, "三段式照旧");
        assert.ok(!(await panel.evaluate(`document.documentElement.innerHTML`)).includes(GOOD_KEY.slice(8, 20)));
      } finally {
        await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify(before)}), chrome.storage.session.remove(${JSON.stringify(API_KEY_SESSION_KEY)})]).then(() => true)`);
      }
    });
  } finally {
    await service.close();
  }
  // 这两次生成都是故意失败的，后台照常记一笔。
}, { expectedErrors: [/background\.js：概览生成失败 Error$/] });

test("侧边栏：不到 5 分钟的短视频打开就进精读，跟着播放的字幕在，不摆生成概览；没设置 AI 服务时也不摆整理字幕", async (ctx) => {
  await withVideo(
    ctx,
    async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      await waitIn(panel, "进了精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
      assert.equal(await panel.evaluate(`document.querySelector(".mode-view")?.getAttribute("aria-label")`), "精读");
      assert.equal(await panel.evaluate(`[...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览")`), false);
      assert.ok(await panel.evaluate(`[...document.querySelectorAll(".dock .button")].some((node) => node.textContent === "存笔记")`), "精读的工具条有存笔记");
      // 整理字幕要花额度：没设置 AI 服务时先不摆，顶上那一行带人去设置（配置检查是异步的，没问到时先摆着停用的，等它落定）。
      await waitIn(panel, "没设置时不摆整理字幕", `!document.querySelector(".study .tidy-row")`);
    },
    BRIEF_SAMPLE.id,
  );
});

// 精读的当前句在每套主题里怎么标：读的是计算出来的颜色，和主题变量比。
const activeCueLook = `(() => {
  const cue = document.querySelector(".cue[data-active='true']");
  if (!cue) return null;
  const color = (name) => { const probe = document.createElement("i"); probe.style.color = "var(" + name + ")"; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
  const row = getComputedStyle(cue);
  const time = getComputedStyle(cue.querySelector(".cue-time"));
  return {
    rowBg: row.backgroundColor,
    rowShadow: row.boxShadow,
    timeBg: time.backgroundColor,
    timeColor: time.color,
    timeLine: time.borderRightWidth + " " + time.borderRightColor,
    vars: Object.fromEntries(["--bg", "--mark", "--on-mark", "--accent-text", "--bg-active", "--text", "--now-tint", "--bg-subtle", "--panel-bg"].map((name) => [name, color(name)])),
  };
})()`;

test("侧边栏：五套主题各自标出精读的当前句：时间码铺页面底色、时间码是红底胶囊；荧光笔时间戳右边换粗线；看不看铺分隔线那档灰、时间用正文色；粉蓝铺浅蓝底、左边一道竖线；红黑铺浅灰、时间码反显", async (ctx) => {
  await withVideo(
    ctx,
    async (panel) => {
      await waitIn(panel, "进了精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
      await waitIn(panel, "播放到的那句标出来", `Boolean(document.querySelector(".cue[data-active='true']"))`);
      // 当前句的底色有过渡：先关掉，读到的是落定的颜色。
      await panel.evaluate(`(() => { const style = document.createElement("style"); style.id = "no-motion"; style.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }"; document.head.append(style); return true; })()`);
      try {
        for (const accentTheme of ["timecode", "marker", "band", "pinkblue", "redblack"]) {
          for (const themeMode of ["light", "dark"]) {
            await panel.setAppearance({ accentTheme, themeMode, uiFontScale: 100 });
            const look = await panel.evaluate(activeCueLook);
            const label = `${accentTheme} ${themeMode}：${JSON.stringify(look)}`;
            assert.ok(look, label);
            const { vars } = look;
            if (accentTheme === "timecode") {
              assert.equal(look.rowBg, vars["--bg"], `当前句铺页面底色：${label}`);
              assert.deepEqual([look.timeBg, look.timeColor], [vars["--mark"], vars["--on-mark"]], `时间码是红底胶囊：${label}`);
            } else if (accentTheme === "marker") {
              assert.equal(look.rowBg, "rgba(0, 0, 0, 0)", `不铺底：${label}`);
              assert.equal(look.timeLine, `2px ${vars["--accent-text"]}`, `时间戳右边换成钢笔蓝的粗线：${label}`);
            } else if (accentTheme === "band") {
              assert.equal(look.rowBg, vars["--bg-active"], `整行铺分隔线那档灰：${label}`);
              assert.equal(look.timeColor, vars["--text"], `时间用正文色：${label}`);
            } else if (accentTheme === "pinkblue") {
              assert.equal(look.rowBg, vars["--now-tint"], `铺浅蓝底：${label}`);
              assert.ok(look.rowShadow.includes("inset") && look.rowShadow.includes(vars["--mark"] ?? "?"), `左边一道蓝竖线：${label}`);
            } else {
              assert.equal(look.rowBg, vars["--bg-subtle"], `铺浅灰：${label}`);
              assert.deepEqual([look.timeBg, look.timeColor], [vars["--text"], vars["--panel-bg"]], `时间码反显：${label}`);
            }
          }
        }
      } finally {
        await panel.evaluate(`(document.getElementById("no-motion")?.remove(), true)`);
        await panel.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: 100 });
      }
    },
    BRIEF_SAMPLE.id,
    playingWatchPage(BRIEF_SAMPLE.id),
  );
});

/** 精读里吸顶的几层在视口里的位置：模式切换和提示一层、当前章节、字幕的工具行；带上页面写进外壳的两个高度变量。 */
const stickyLayout = `(() => {
  const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
  const shell = document.querySelector(".panel")?.style;
  return { top: box(".panel-top"), notice: box(".panel-top .notice"), chapter: box(".study .chapter-bar"), tools: box(".study .cue-tools"), scrolled: scrollY, viewport: innerHeight, vars: [shell?.getPropertyValue("--panel-top-h"), shell?.getPropertyValue("--chapter-bar-h")] };
})()`;
/** 三层首尾相接：吸顶那一层贴着顶，章节条接在它下面，工具行接在章节条下面。等的和后面断言的是同一组位置关系。 */
const stickyStacked = `(() => { const at = ${stickyLayout}; return Boolean(at.top && at.chapter && at.tools && Math.abs(at.top.top) < 1 && Math.abs(at.chapter.top - at.top.bottom) < 1 && Math.abs(at.tools.top - at.chapter.bottom) < 1); })()`;

test("侧边栏：精读里往下滚，模式切换和提示一起吸在顶上，当前章节和字幕的工具行接着吸在下面、彼此不压；360 和 400 宽时加起来都不到视口的四成", async (ctx) => {
  await withVideo(
    ctx,
    async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      await waitIn(panel, "进了精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
      // 顶上那一行提示要先在（这个样例是字幕时间轴对不上的提示，窄宽度下折成两行）。
      await waitIn(panel, "顶上有一行提示", `Boolean(document.querySelector(".panel-top .notice"))`);
      // 当前章节要等侧边栏问到播放位置才出来，早晚不定：先等它在，每一轮都量得到三层。
      await waitIn(panel, "当前章节出来了", `Boolean(document.querySelector(".study .chapter-bar"))`);
      // 字幕跟着播放，当前句一出来就被滚到中间，这一下在章节条画出来以后才跑；直接 scrollTo 不算用户在滚，跟随晚一点到就把页面拉回顶上。
      // 像用户那样在字幕上滚一下滚轮，停下跟随，等「回到当前句」出来再往下滚。
      await panel.evaluate(`(document.querySelector(".study .cues").dispatchEvent(new WheelEvent("wheel", { bubbles: true })), true)`);
      await waitIn(panel, "停下跟随", `Boolean(document.querySelector(".follow-pill[data-shown]"))`);
      // 短视频的字幕只有几段，撑高精读这一块才滚得动：吸在章节下面的几层只在这一块里吸着。
      await panel.evaluate(`(document.querySelector(".study").style.minHeight = "4000px", true)`);
      try {
        for (const width of [360, 400]) {
          await panel.setWidth(width, 800);
          await panel.evaluate("(scrollTo(0, 2500), true)");
          await waitIn(panel, `${width} 宽：滚下去了`, "scrollY > 0");
          // 换了宽度，提示和章节条的折行会变，两层的高度要等页面量好、写进变量，下面的层才跟上。章节条和工具行各跟各的变量，
          // 只等工具行接上章节条不够：吸顶那一层的变量还旧着时，这两层一起错开、彼此照样接得上。
          try {
            await waitIn(panel, `${width} 宽：三层首尾相接`, stickyStacked);
          } catch (error) {
            // 高度变量只在页面画新的一帧时更新：一并记下半秒里画了几帧、页面是不是可见。
            const frames = await panel.evaluate(`new Promise((done) => { let count = 0; const tick = () => { count += 1; requestAnimationFrame(tick); }; requestAnimationFrame(tick); setTimeout(() => done({ frames: count, visibility: document.visibilityState }), 500); })`);
            throw new Error(`${error.message}\n位置：${JSON.stringify(await panel.evaluate(stickyLayout))}\n半秒里：${JSON.stringify(frames)}`);
          }
          const at = await panel.evaluate(stickyLayout);
          const label = `${width} 宽：${JSON.stringify(at)}`;
          assert.ok(at.top && at.notice && at.chapter && at.tools, label);
          assert.ok(Math.abs(at.top.top) < 1, `模式切换和提示吸在顶上：${label}`);
          assert.ok(at.notice.top >= 0 && at.notice.bottom <= at.top.bottom + 0.5, `提示在吸顶那一层里、看得见：${label}`);
          assert.ok(Math.abs(at.chapter.top - at.top.bottom) < 1, `当前章节接在吸顶那一层下面：${label}`);
          assert.ok(Math.abs(at.tools.top - at.chapter.bottom) < 1, `字幕的工具行接在当前章节下面，不压着：${label}`);
          assert.ok(at.tools.bottom - at.top.top <= at.viewport * 0.4, `吸顶的几层加起来不到视口的四成：${label}`);
          // 滚下去以后工具行里的菜单照样够得着，复制的结果落在吸顶的提示里，看得见。
          await panel.evaluate(recordClipboard);
          await tap(panel, ".study .cue-tools [aria-label='更多字幕操作']");
          assert.ok(await clickText(panel, ".menu-item", "复制全部字幕"));
          await waitIn(panel, `${width} 宽：复制的结果看得见`, `(() => { const node = [...document.querySelectorAll(".panel-top .notice-text")].find((item) => item.textContent === "已复制全部字幕"); if (!node) return false; const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
        }
      } finally {
        await panel.evaluate(`(document.querySelector(".study").style.minHeight = "", scrollTo(0, 0), true)`);
        await panel.setWidth(360, 800);
      }
    },
    BRIEF_SAMPLE.id,
  );
});

// 这个测试会记住第一个样例视频的频道，做完从设置页清掉，免得影响后面打开同一个视频的测试。
test("侧边栏：主动切到精读立刻换、说一声记住了、旁边给「不记」；同一频道再打开就进精读；设置页写明记住了几个，「清除记住的 UP 主」以后回到按时长进速读；点「不记」只忘掉这一个、模式不变", async (ctx) => {
  try {
    await withVideo(ctx, async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      assert.deepEqual(await panel.evaluate(modes), SKIM);
      assert.ok(await clickText(panel, ".mode", "精读"));
      await waitIn(panel, "换成精读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "精读"`);
      assert.deepEqual(await panel.evaluate(modes), STUDY);
      await waitIn(panel, "说记住了", `${textOf(".notice-text")}.includes("已记住：样例作者的视频以后先进精读")`);
      assert.equal(await panel.evaluate(textOf(".notice .notice-action")), "不记");
    });
    await withVideo(ctx, async (panel) => {
      await waitIn(panel, "按频道进精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
    });
  } finally {
    // 从设置页「速读和精读」一节清掉记住的 UP 主：先写明记住了几个。
    const options = await ctx.open("pages/options.html");
    await options.waitFor("速读和精读一节写明记住了几个", `document.querySelector("#modes .field-hint")?.textContent === "已记住 1 个 UP 主或频道。"`);
    await options.evaluate(`(document.querySelector("#modes .button").click(), true)`);
    await options.evaluate(`([...document.querySelectorAll("#modes .button")].find((node) => node.textContent === "清除").click(), true)`);
    await options.waitFor("清除好了", `document.querySelector("#modes .status")?.textContent.startsWith("已清除")`);
    assert.equal(await options.evaluate(`Boolean(document.querySelector("#modes .button") || document.querySelector("#modes .field-hint"))`), false, "一个都没记了：不摆清除按钮");
  }
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    assert.deepEqual(await panel.evaluate(modes), SKIM, "清掉以后回到按时长");
    // 再切一次，这次点「不记」：模式留在精读，这个 UP 主不记。
    assert.ok(await clickText(panel, ".mode", "精读"));
    await waitIn(panel, "说记住了", `${textOf(".notice-text")}.includes("已记住：")`);
    assert.ok(await clickText(panel, ".notice .notice-action", "不记"));
    await waitIn(panel, "说不记了", `${textOf(".notice-text")} === "好，不记这个 UP 主"`);
    assert.deepEqual(await panel.evaluate(modes), STUDY, "眼下的模式不变");
  });
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    assert.deepEqual(await panel.evaluate(modes), SKIM, "不记以后回到按时长");
  });
});

// 要真的播满 1 分钟，这个测试要一分多钟。
test("侧边栏：长视频在速读里播满 1 分钟，侧边栏开着就不切；报不出侧边栏开关的浏览器里照样切，问答抽屉和草稿都留着；顶上一行「已切到精读」，点一下回速读、这次不再切", async (ctx) => {
  await withVideo(
    ctx,
    async (panel, _from, tabId) => {
      await waitIn(panel, "长视频进速读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "速读"`);
      await tap(panel, ".dock [aria-label='问答记录']");
      await waitIn(panel, "问答抽屉打开", `${qaSheet}?.open === true`);
      await panel.evaluate(`(() => { const input = document.querySelector(".qa-form input"); input.value = "还没发出去的草稿"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      const watched = `chrome.storage.session.get(${JSON.stringify(WATCH_SESSIONS_KEY)}).then((items) => items[${JSON.stringify(WATCH_SESSIONS_KEY)}]?.[${JSON.stringify(String(tabId))}] ?? null)`;
      // 侧边栏是真的开着的（浏览器报了开）：播过 1 分钟也留在速读。
      await waitIn(panel, "播满 1 分钟多", `${watched}.then((session) => (session?.playedSec ?? 0) >= 70)`, 120_000);
      assert.equal(await panel.evaluate(`document.querySelector(".mode-view")?.getAttribute("aria-label")`), "速读", "侧边栏开着不切");
      assert.deepEqual(await panel.evaluate(`${watched}.then((session) => [session?.modeSource, session?.autoSwitched])`), ["default", false]);

      // 报不出侧边栏开关的老版本浏览器里，后台记的开着的窗口一直是空的：清空它，下一次上报就切。
      await panel.evaluate(`chrome.storage.session.set({ ${JSON.stringify(OPEN_PANELS_KEY)}: [] }).then(() => true)`);
      await waitIn(panel, "下一次上报切到精读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "精读"`, 30_000);
      assert.equal(await panel.evaluate(`${qaSheet}?.open`), true, "切模式不关抽屉");
      assert.equal(await panel.evaluate(`document.querySelector(".qa-form input").value`), "还没发出去的草稿", "草稿留着");
      const stored = await panel.evaluate(`chrome.storage.session.get(${JSON.stringify(WATCH_SESSIONS_KEY)})`);
      const session = stored[WATCH_SESSIONS_KEY]?.[String(tabId)];
      assert.equal(session?.modeSource, "auto");
      assert.equal(session?.channel, channelKey({ platform: "bilibili", channelId: PLAYING_SAMPLE.channel }), "会话记着频道");

      await panel.evaluate(`(${qaSheet}).querySelector(".overlay-head [aria-label='关闭']").click(), true`);
      await waitIn(panel, "顶上一行", `${textOf(".notice-text")} === "已切到精读"`);
      assert.ok(await clickText(panel, ".notice-action", "回到速读"));
      await waitIn(panel, "回到速读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "速读"`);
      await waitIn(panel, "这一行消失", `!${textOf(".notice-text")}.includes("已切到精读")`);
      const after = await panel.evaluate(`chrome.storage.session.get(${JSON.stringify(WATCH_SESSIONS_KEY)})`);
      assert.equal(after[WATCH_SESSIONS_KEY]?.[String(tabId)]?.autoSwitched, true, "这次观看记着切过，不再切");
    },
    PLAYING_SAMPLE.id,
    playingWatchPage(PLAYING_SAMPLE.id),
  );
}, { timeoutMs: 180_000 });

/** 把设置里的语言改成这一项，回改之前存着的设置（没有时是 null）。 */
async function setLanguage(panel, language) {
  const key = JSON.stringify(SETTINGS_STORAGE_KEY);
  return panel.evaluate(
    `chrome.storage.local.get(${key}).then((items) => { const before = items[${key}] ?? null; return chrome.storage.local.set({ [${key}]: { ...(before ?? {}), language: ${JSON.stringify(language)} } }).then(() => before); })`,
  );
}

/** 把设置还原成改语言之前的样子。 */
const restoreSettings = (panel, before) =>
  panel.evaluate(
    before === null
      ? `chrome.storage.local.remove(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then(() => true)`
      : `chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: before })}).then(() => true)`,
  );

test("侧边栏：语言选 English 以后，模式切换、底部工具条、各个状态的标题和按钮、问答抽屉、笔记层都是英文，<html lang> 是 en；切回中文恢复", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await waitIn(panel, "设置 AI 服务的主按钮", `[...document.querySelectorAll(".button")].some((node) => node.textContent === "设置 AI 服务")`);
    await waitIn(panel, "没设置的提示", `Boolean(document.querySelector(${JSON.stringify(CONFIG_ACTION)}))`);
    assert.equal(await panel.evaluate(`document.documentElement.lang`), "zh-CN");
    const before = await setLanguage(panel, "en");
    try {
      await waitIn(panel, "界面换成英文", `document.documentElement.lang === "en"`);
      assert.equal(await panel.evaluate("document.title"), "Jianmu");
      assert.deepEqual(await panel.evaluate(modes), [
        ["Skim", "true"],
        ["Study", "false"],
      ]);
      const view = await panel.evaluate(`({
        modeView: document.querySelector(".mode-view")?.getAttribute("aria-label"),
        modeGroup: document.querySelector(".modes")?.getAttribute("aria-label"),
        settings: document.querySelector(".panel-head .icon-button")?.getAttribute("aria-label"),
        notes: document.querySelector(".mode-row .icon-button")?.getAttribute("aria-label"),
        ask: document.querySelector(".ask-entry input")?.getAttribute("aria-label"),
        askPlaceholder: document.querySelector(".ask-entry input")?.placeholder,
        history: document.querySelector(".dock .icon-button")?.getAttribute("aria-label"),
        config: document.querySelector('.notice[data-id="config"] .notice-text')?.textContent,
        configAction: document.querySelector(${JSON.stringify(CONFIG_ACTION)})?.textContent,
        official: document.querySelector(".guide .section-title")?.textContent,
        buttons: [...document.querySelectorAll(".ai-overview .button")].map((node) => node.textContent),
        count: document.querySelector(".toolbar-count")?.textContent ?? "",
      })`);
      const { count, ...rest } = view;
      assert.deepEqual(rest, {
        modeView: "Skim",
        modeGroup: "Mode",
        settings: "Open settings",
        notes: "Notes",
        ask: "Ask about this video",
        askPlaceholder: "Ask about this video, then press Enter",
        history: "Q&A history",
        config: "Subtitles work without setup. Overviews and Q&A need an AI service set up first",
        configAction: "Open settings",
        official: "Bilibili's official summary",
        buttons: ["Set up AI service", "Export study notes"],
      });
      assert.match(count, /^\d+ segments?$/);

      // 问答抽屉：标题、输入框、按钮、说明和空状态。
      const sheet = `[...document.querySelectorAll(".sheet")].find((node) => node.querySelector(".overlay-title")?.textContent === "Q&A")`;
      await tap(panel, ".dock [aria-label='Q&A history']");
      await waitIn(panel, "问答抽屉打开", `${sheet}?.open === true`);
      await waitIn(panel, "问答的空状态", `${appText}.includes("No Q&A yet")`);
      const qa = await panel.evaluate(`({
        placeholder: document.querySelector(".qa-form input")?.placeholder,
        button: document.querySelector(".qa-form .button")?.textContent,
        hint: document.querySelector(".qa-hint")?.textContent,
        close: (${sheet}).querySelector(".overlay-head .icon-button")?.getAttribute("aria-label"),
      })`);
      assert.deepEqual(qa, {
        placeholder: "Ask about this video, then press Enter",
        button: "Open settings",
        hint: "Each question is answered on its own, so write follow-up questions out in full.",
        close: "Close",
      });
      await panel.evaluate(`(${sheet}).querySelector(".overlay-head [aria-label='Close']").click(), true`);
      await waitIn(panel, "抽屉关上", `${sheet}?.open === false`);

      // 笔记层：标题、范围切换、导出、搜索框和空状态。
      await tap(panel, ".mode-row [aria-label='Notes']");
      await waitIn(panel, "笔记层打开", `document.querySelector(".layer")?.open === true`);
      await waitIn(panel, "笔记的空状态", `${appText}.includes("No notes yet")`);
      const notes = await panel.evaluate(`({
        title: document.querySelector(".layer .overlay-title")?.textContent,
        scopes: [...document.querySelectorAll(".layer .segment")].map((node) => node.textContent),
        exportButton: document.querySelector(".layer .toolbar-actions .button")?.textContent,
        search: document.querySelector(".layer .search-input")?.placeholder,
        back: document.querySelector(".layer .overlay-head .icon-button")?.getAttribute("aria-label"),
      })`);
      assert.deepEqual(notes, { title: "Notes", scopes: ["This video", "All"], exportButton: "Export Markdown", search: "Search notes, titles or creators", back: "Back" });
      await tap(panel, ".layer [aria-label='Back']");
      await waitIn(panel, "笔记层关上", `document.querySelector(".layer")?.open === false`);

      // 切回中文：同几处又是中文。
      await setLanguage(panel, "zh");
      await waitIn(panel, "界面换回中文", `document.documentElement.lang === "zh-CN"`);
      assert.deepEqual(await panel.evaluate(modes), SKIM);
      assert.equal(await panel.evaluate(`document.querySelector(".ask-entry input")?.getAttribute("aria-label")`), "针对这个视频提问");
      assert.equal(await panel.evaluate("document.title"), "简幕");
      assert.ok(await panel.evaluate(`[...document.querySelectorAll(".button")].some((node) => node.textContent === "设置 AI 服务")`));
    } finally {
      await restoreSettings(panel, before);
    }
  });
});

test("侧边栏：语言选繁体以后，模式切换、底部工具条、各个状态的标题和按钮、问答抽屉、笔记层都是繁体，<html lang> 是 zh-Hant、字体是繁体那组；切回简体恢复", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await waitIn(panel, "设置 AI 服务的主按钮", `[...document.querySelectorAll(".button")].some((node) => node.textContent === "设置 AI 服务")`);
    await waitIn(panel, "没设置的提示", `Boolean(document.querySelector(${JSON.stringify(CONFIG_ACTION)}))`);
    const before = await setLanguage(panel, "zh-Hant");
    try {
      await waitIn(panel, "界面换成繁体", `document.documentElement.lang === "zh-Hant"`);
      assert.equal(await panel.evaluate("document.title"), "簡幕");
      assert.match(await panel.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`), /PingFang TC/);
      assert.deepEqual(await panel.evaluate(modes), [
        ["速讀", "true"],
        ["精讀", "false"],
      ]);
      const view = await panel.evaluate(`({
        modeView: document.querySelector(".mode-view")?.getAttribute("aria-label"),
        modeGroup: document.querySelector(".modes")?.getAttribute("aria-label"),
        settings: document.querySelector(".panel-head .icon-button")?.getAttribute("aria-label"),
        notes: document.querySelector(".mode-row .icon-button")?.getAttribute("aria-label"),
        ask: document.querySelector(".ask-entry input")?.getAttribute("aria-label"),
        askPlaceholder: document.querySelector(".ask-entry input")?.placeholder,
        history: document.querySelector(".dock .icon-button")?.getAttribute("aria-label"),
        config: document.querySelector('.notice[data-id="config"] .notice-text')?.textContent,
        configAction: document.querySelector(${JSON.stringify(CONFIG_ACTION)})?.textContent,
        official: document.querySelector(".guide .section-title")?.textContent,
        buttons: [...document.querySelectorAll(".ai-overview .button")].map((node) => node.textContent).join("|"),
        count: document.querySelector(".toolbar-count")?.textContent ?? "",
      })`);
      for (const [name, text] of Object.entries(view)) {
        assert.ok(text, `${name} 是空的`);
        assert.deepEqual(simplifiedIn(text), [], `${name}：${text}`);
      }
      assert.equal(view.modeView, "速讀");
      assert.equal(view.ask, PANEL_HANT.dock.ask);
      assert.equal(view.history, PANEL_HANT.dock.history);
      assert.equal(view.notes, PANEL_HANT.head.notes);
      assert.ok(view.buttons.split("|").includes(SHARED_HANT.setup.action.none), view.buttons);
      assert.equal(view.official, PANEL_HANT.guides.official);

      // 问答抽屉：标题、输入框、按钮、说明和空状态。
      const sheet = `[...document.querySelectorAll(".sheet")].find((node) => node.querySelector(".overlay-title")?.textContent === ${JSON.stringify(PANEL_HANT.qa.title)})`;
      await tap(panel, `.dock [aria-label='${PANEL_HANT.dock.history}']`);
      await waitIn(panel, "问答抽屉打开", `${sheet}?.open === true`);
      await waitIn(panel, "问答的空状态", `${appText}.includes(${JSON.stringify(PANEL_HANT.qa.emptyTitle)})`);
      const qa = await panel.evaluate(`({
        placeholder: document.querySelector(".qa-form input")?.placeholder,
        button: document.querySelector(".qa-form .button")?.textContent,
        hint: document.querySelector(".qa-hint")?.textContent,
        close: (${sheet}).querySelector(".overlay-head .icon-button")?.getAttribute("aria-label"),
        all: (${sheet}).innerText,
      })`);
      assert.equal(qa.placeholder, PANEL_HANT.qa.placeholder);
      assert.equal(qa.button, PANEL_HANT.openSettings);
      assert.equal(qa.hint, PANEL_HANT.qa.hint);
      for (const [name, text] of Object.entries(qa)) assert.deepEqual(simplifiedIn(text), [], `问答抽屉 ${name}：${text}`);
      await panel.evaluate(`(${sheet}).querySelector(".overlay-head .icon-button").click(), true`);
      await waitIn(panel, "抽屉关上", `${sheet}?.open === false`);

      // 笔记层：标题、范围切换、导出、搜索框和空状态。
      await tap(panel, `.mode-row [aria-label='${PANEL_HANT.head.notes}']`);
      await waitIn(panel, "笔记层打开", `document.querySelector(".layer")?.open === true`);
      await waitIn(panel, "笔记的空状态", `${appText}.includes(${JSON.stringify(PANEL_HANT.notes.emptyTitle)})`);
      const notes = await panel.evaluate(`({
        title: document.querySelector(".layer .overlay-title")?.textContent,
        scopes: [...document.querySelectorAll(".layer .segment")].map((node) => node.textContent).join("|"),
        exportButton: document.querySelector(".layer .toolbar-actions .button")?.textContent,
        search: document.querySelector(".layer .search-input")?.placeholder,
        back: document.querySelector(".layer .overlay-head .icon-button")?.getAttribute("aria-label"),
        all: document.querySelector(".layer").innerText,
      })`);
      assert.equal(notes.search, PANEL_HANT.notes.searchPlaceholder);
      for (const [name, text] of Object.entries(notes)) {
        assert.ok(text, `笔记层 ${name} 是空的`);
        assert.deepEqual(simplifiedIn(text), [], `笔记层 ${name}：${text}`);
      }
      await panel.evaluate(`document.querySelector(".layer .overlay-head .icon-button").click(), true`);
      await waitIn(panel, "笔记层关上", `document.querySelector(".layer")?.open === false`);

      // 切回简体：同几处又是简体。
      await setLanguage(panel, "zh");
      await waitIn(panel, "界面换回简体", `document.documentElement.lang === "zh-CN"`);
      assert.deepEqual(await panel.evaluate(modes), SKIM);
      assert.equal(await panel.evaluate(`document.querySelector(".ask-entry input")?.getAttribute("aria-label")`), "针对这个视频提问");
      assert.equal(await panel.evaluate("document.title"), "简幕");
      assert.match(await panel.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`), /PingFang SC/);
    } finally {
      await restoreSettings(panel, before);
    }
  });
});

test("侧边栏：English 下精读的底部工具条、字幕视图和解释画面是英文；没设置 AI 服务时不摆整理字幕", async (ctx) => {
  await withVideo(
    ctx,
    async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      await waitIn(panel, "进了精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
      const before = await setLanguage(panel, "en");
      try {
        await waitIn(panel, "界面换成英文", `document.documentElement.lang === "en"`);
        await waitIn(panel, "没设置时不摆整理字幕", `!document.querySelector(".study .tidy-row")`);
        const view = await panel.evaluate(`({
          modeView: document.querySelector(".mode-view")?.getAttribute("aria-label"),
          dock: [document.querySelector(".dock .ask-entry input")?.getAttribute("aria-label"), ...[...document.querySelectorAll(".dock button")].map((node) => node.textContent || node.getAttribute("aria-label"))],
          tidy: Boolean(document.querySelector(".study .tidy-row")),
          view: document.querySelector(".study .toolbar .menu-anchor .button")?.textContent,
        })`);
        assert.deepEqual(view, {
          modeView: "Study",
          dock: ["Ask about this video", "Q&A history", "Save note", "Explain this frame"],
          tidy: false,
          view: "Original",
        });
      } finally {
        await restoreSettings(panel, before);
      }
      await waitIn(panel, "界面换回中文", `document.documentElement.lang === "zh-CN"`);
      assert.ok(await panel.evaluate(`[...document.querySelectorAll(".dock .button")].some((node) => node.textContent === "存笔记")`));
    },
    BRIEF_SAMPLE.id,
  );
});
