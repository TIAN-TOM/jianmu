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
import { API_KEY_SESSION_KEY, AUTO_LEDGER_KEY, DATABASE_NAME, SETTINGS_STORAGE_KEY, WATCH_SESSIONS_KEY } from "../../src/shared/names.ts";
import { ANTHROPIC, BRIEF_SAMPLE, PLAYING_SAMPLE, VIDEOS } from "../fixtures.mjs";
import { playingWatchPage, PROBE, watchPage } from "../mock-server.mjs";
import { storedSettings } from "../settings.mjs";
import { charsIn, SIMPLIFIED_ONLY } from "../../tests/helpers/hant-chars.ts";
import { stillFalse } from "../../tests/helpers/wait-until.ts";
import { PANEL_HANT } from "../../src/pages/sidepanel/text-hant.ts";
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
    await waitIn(panel, "知道播放位置", `Boolean(document.querySelector(".follow-pill"))`);
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
      await panel.evaluate("location.reload(), true");
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

test("侧边栏：速读还没有概览时先摆官方总结；没设置 AI 服务时生成概览停用并写明原因", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await waitIn(panel, "官方总结", `${textOf(".guide-summary")}.includes("这是自造的样例总结。")`);
    await waitIn(panel, "生成概览停用", `(() => { const button = [...document.querySelectorAll(".button")].find((node) => node.textContent === "生成概览"); return button?.disabled === true; })()`);
    assert.ok((await panel.evaluate(textOf(".control-reason"))).includes("先在设置页设置 AI 服务"));
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
    } finally {
      await panel.evaluate(closeOptions);
    }
  });
});

test("侧边栏：配好过、密钥随浏览器重启清空时，顶上那行和按钮下面都直说要重新填密钥，提一句记住密钥", async (ctx) => {
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
      assert.ok((await panel.evaluate(textOf(".control-reason"))).includes("先在设置页重新填 API 密钥"));
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

test("侧边栏：底下的提问框没设置 AI 服务时按回车不发请求，字留着，打开问答抽屉写明原因；关上抽屉焦点回到提问框", async (ctx) => {
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
    assert.equal(await panel.evaluate(`document.querySelector(".qa-form .button").disabled`), true);
    assert.ok((await panel.evaluate(textOf(".qa-form .control-reason"))).includes("先在设置页设置 AI 服务"), "原因写在抽屉里的提问按钮旁边");
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

test("侧边栏：问答里的「复制回答」复制回答，时间点按 [分:秒] 写回去，说一声已复制", async (ctx) => {
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
    await tap(panel, ".qa-entry [aria-label='复制回答']");
    await waitIn(panel, "复制了回答", `${copiedTexts}.length === 1`);
    assert.equal((await panel.evaluate(copiedTexts))[0], answer, "时间点带回方括号，和存着的回答一字不差");
    await waitIn(panel, "说已复制", copiedSaid);
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
    assert.deepEqual(await panel.evaluate(heading), ["A Long Sample Video", FIRST_TITLE], "标题是译名，悬停是原标题");

    await showWith({ verdict: "可以看", summary: "旧版的结论" }, "没有译名的结论摆出来");
    assert.deepEqual(await panel.evaluate(heading), [FIRST_TITLE, FIRST_TITLE], "旧结论没有译名，照旧是原标题");
  } finally {
    await editDatabase(panel, {}, { overviews: [VIDEO] });
    for (const tabId of tabs) await closeTab(from, tabId);
  }
});

test("侧边栏：没设置 AI 服务时本窗口全部生成停用；设置好以后清点写清几个视频、要新生成几个，取消回到按钮", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const batchButton = `[...document.querySelectorAll(".batch-bar .button")].find((node) => node.textContent.startsWith("本窗口全部生成"))`;
    await waitIn(panel, "批量按钮停用", `${batchButton}?.disabled === true`);
    assert.ok((await panel.evaluate(textOf(".batch-bar .control-reason"))).includes("先在设置页设置 AI 服务"));

    // 只在这个测试里配好模型服务，做完还原，后面的测试照旧是没设置的样子。
    const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    await panel.evaluate(`Promise.all([chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: stored.local[SETTINGS_STORAGE_KEY] })}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
    try {
      await waitIn(panel, "批量按钮能点", `${batchButton}?.disabled === false`);
      await panel.evaluate(`(${batchButton}).click(), true`);
      await waitIn(panel, "清点完给出确认", `${textOf(".batch-bar .batch-status")} === "本窗口有 1 个视频，要新生成 1 个。"`);
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

test("侧边栏：打开就出结论因为额度用完停着时，顶上一行写明怎么恢复；关掉开关以后这一行消失", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    const before = await panel.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
    const stored = await storedSettings(ANTHROPIC);
    const settings = { ...stored.local[SETTINGS_STORAGE_KEY], autoOverview: true };
    const paused = { tried: [], sent: [], paused: { reason: "quota", at: Date.now() } };
    const setLocal = (value) => panel.evaluate(`chrome.storage.local.set(${JSON.stringify({ [SETTINGS_STORAGE_KEY]: value })}).then(() => true)`);
    // 先打开开关（开关一动后台就清掉暂停），再放一份停着的记录，然后改一项别的设置让侧边栏重问配置。
    await panel.evaluate(`chrome.storage.session.set(${JSON.stringify(stored.session)}).then(() => true)`);
    await setLocal(settings);
    try {
      await waitIn(panel, "配置齐了", `!${textOf(".notice-text")}.includes("要先设置 AI 服务")`);
      await panel.evaluate(`chrome.storage.session.set(${JSON.stringify({ [AUTO_LEDGER_KEY]: paused })}).then(() => true)`);
      await setLocal({ ...settings, analysisChunkMode: "short" });
      await waitIn(panel, "暂停的提示", `${textOf(".notice-text")}.includes("额度用完，打开就出结论已暂停")`);
      // 关掉开关：后台从暂停里恢复，告诉页面以后这一行消失。
      await setLocal({ ...settings, analysisChunkMode: "short", autoOverview: false });
      await waitIn(panel, "提示消失", `!${textOf(".notice-text")}.includes("打开就出结论已暂停")`);
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

test("侧边栏：不到 5 分钟的短视频打开就进精读，跟着播放的字幕在，不摆生成概览", async (ctx) => {
  await withVideo(
    ctx,
    async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      await waitIn(panel, "进了精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
      assert.equal(await panel.evaluate(`document.querySelector(".mode-view")?.getAttribute("aria-label")`), "精读");
      assert.equal(await panel.evaluate(`[...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览")`), false);
      assert.ok(await panel.evaluate(`[...document.querySelectorAll(".dock .button")].some((node) => node.textContent === "存笔记")`), "精读的工具条有存笔记");
      // 整理字幕：只在点的时候做，按钮旁写明要花额度；没设置 AI 服务时停用（配置检查是异步的，等它落定）。
      await waitIn(panel, "整理字幕停用", `document.querySelector(".study .tidy-row .button")?.disabled === true`);
      const tidy = await panel.evaluate(`(() => { const row = document.querySelector(".study .tidy-row"); const button = row?.querySelector(".button"); return { text: button?.textContent, disabled: button?.disabled, note: row?.querySelector(".control-note")?.textContent, reason: row?.querySelector(".control-reason")?.textContent }; })()`);
      assert.equal(tidy.text, "整理字幕");
      assert.equal(tidy.disabled, true);
      assert.match(tidy.note ?? "", /要用 API 额度/);
      assert.match(tidy.reason ?? "", /先在设置页设置 AI 服务/);
    },
    BRIEF_SAMPLE.id,
  );
});

// 这个测试会记住第一个样例视频的频道，做完从设置页清掉，免得影响后面打开同一个视频的测试。
test("侧边栏：主动切到精读立刻换、说一声记住了；同一频道再打开就进精读；设置页「清除记住的 UP 主」以后回到按时长进速读", async (ctx) => {
  try {
    await withVideo(ctx, async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      assert.deepEqual(await panel.evaluate(modes), SKIM);
      assert.ok(await clickText(panel, ".mode", "精读"));
      await waitIn(panel, "换成精读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "精读"`);
      assert.deepEqual(await panel.evaluate(modes), STUDY);
      await waitIn(panel, "说记住了", `${textOf(".notice-text")}.includes("已记住：样例作者的视频以后先进精读")`);
    });
    await withVideo(ctx, async (panel) => {
      await waitIn(panel, "按频道进精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
    });
  } finally {
    // 从设置页「速读和精读」一节清掉记住的 UP 主。
    const options = await ctx.open("pages/options.html");
    await options.waitFor("速读和精读一节", `Boolean(document.querySelector("#modes .button"))`);
    await options.evaluate(`(document.querySelector("#modes .button").click(), true)`);
    await options.evaluate(`([...document.querySelectorAll("#modes .button")].find((node) => node.textContent === "清除").click(), true)`);
    await options.waitFor("清除好了", `document.querySelector("#modes .status")?.textContent.startsWith("已清除")`);
  }
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    assert.deepEqual(await panel.evaluate(modes), SKIM, "清掉以后回到按时长");
  });
});

// 要真的播满 1 分钟，这个测试要一分多钟。
test("侧边栏：长视频在速读里连续播满 1 分钟切到精读，问答抽屉和草稿都留着；顶上一行「已切到精读」，点一下回速读、这次不再切", async (ctx) => {
  await withVideo(
    ctx,
    async (panel, _from, tabId) => {
      await waitIn(panel, "长视频进速读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "速读"`);
      await tap(panel, ".dock [aria-label='问答记录']");
      await waitIn(panel, "问答抽屉打开", `${qaSheet}?.open === true`);
      await panel.evaluate(`(() => { const input = document.querySelector(".qa-form input"); input.value = "还没发出去的草稿"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await waitIn(panel, "播满 1 分钟切到精读", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "精读"`, 120_000);
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
}, { timeoutMs: 150_000 });

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
    await waitIn(panel, "生成概览停用", `[...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览" && node.disabled)`);
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
        batch: document.querySelector(".batch-bar .button")?.textContent,
        buttons: [...document.querySelectorAll(".ai-overview .button")].map((node) => node.textContent),
        reasons: [...new Set([...document.querySelectorAll(".ai-overview .control-reason")].map((node) => node.textContent))],
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
        batch: "Generate all in this window",
        buttons: ["Generate overview", "Export study notes"],
        reasons: ["Set up an AI service in settings first"],
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
        button: "Ask",
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
      assert.ok(await panel.evaluate(`[...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览")`));
    } finally {
      await restoreSettings(panel, before);
    }
  });
});

test("侧边栏：语言选繁体以后，模式切换、底部工具条、各个状态的标题和按钮、问答抽屉、笔记层都是繁体，<html lang> 是 zh-Hant、字体是繁体那组；切回简体恢复", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await waitIn(panel, "生成概览停用", `[...document.querySelectorAll(".button")].some((node) => node.textContent === "生成概览" && node.disabled)`);
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
        batch: document.querySelector(".batch-bar .button")?.textContent,
        buttons: [...document.querySelectorAll(".ai-overview .button")].map((node) => node.textContent).join("|"),
        reasons: [...new Set([...document.querySelectorAll(".ai-overview .control-reason")].map((node) => node.textContent))].join("|"),
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
      assert.ok(view.buttons.split("|").includes(PANEL_HANT.skim.generate), view.buttons);

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
      assert.equal(qa.button, PANEL_HANT.qa.ask);
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

test("侧边栏：English 下精读的底部工具条、整理字幕和解释画面是英文", async (ctx) => {
  await withVideo(
    ctx,
    async (panel) => {
      await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
      await waitIn(panel, "进了精读", `JSON.stringify(${modes}) === ${JSON.stringify(JSON.stringify(STUDY))}`);
      const before = await setLanguage(panel, "en");
      try {
        await waitIn(panel, "界面换成英文", `document.documentElement.lang === "en"`);
        await waitIn(panel, "整理字幕停用", `document.querySelector(".study .tidy-row .button")?.disabled === true`);
        const view = await panel.evaluate(`({
          modeView: document.querySelector(".mode-view")?.getAttribute("aria-label"),
          dock: [document.querySelector(".dock .ask-entry input")?.getAttribute("aria-label"), ...[...document.querySelectorAll(".dock button")].map((node) => node.textContent || node.getAttribute("aria-label"))],
          tidy: document.querySelector(".study .tidy-row .button")?.textContent,
          reason: document.querySelector(".study .tidy-row .control-reason")?.textContent,
        })`);
        assert.deepEqual(view, {
          modeView: "Study",
          dock: ["Ask about this video", "Q&A history", "Save note", "Explain this frame"],
          tidy: "Tidy up subtitles",
          reason: "Set up an AI service in settings first",
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
