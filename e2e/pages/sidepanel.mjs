// 侧边栏：确认启用前只有启用说明；没有视频时说明怎么用；视频页上读不到字幕、读到字幕，速览和精读、问答抽屉、笔记层的主要状态；
// 打开时按时长定模式，主动切换记住频道，设置页清掉以后回到按时长。
// 页面测试里没有设置模型服务的密钥：概览和问答停在要先设置 AI 服务。
// 几个测试按顺序共用同一个浏览器：第一个确认启用，第二个还没登录，第三个起已登录。
import assert from "node:assert/strict";
import { errorCopy } from "../../src/core/errors.ts";
import { channelKey, videoKey } from "../../src/core/video-ref.ts";
import { API_KEY_SESSION_KEY, AUTO_LEDGER_KEY, SETTINGS_STORAGE_KEY, WATCH_SESSIONS_KEY } from "../../src/shared/names.ts";
import { ANTHROPIC, BRIEF_SAMPLE, PLAYING_SAMPLE, VIDEOS } from "../fixtures.mjs";
import { playingWatchPage, PROBE, watchPage } from "../mock-server.mjs";
import { storedSettings } from "../settings.mjs";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const LAUNCHER = "pages/gallery.html";
const [FIRST_ID = ""] = Object.keys(VIDEOS);
const FIRST_TITLE = VIDEOS[FIRST_ID]?.title ?? "";
const VIDEO = videoKey({ platform: "bilibili", videoId: FIRST_ID });

const appText = `(document.getElementById("app")?.innerText ?? "")`;
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
  ["速览", "true"],
  ["精读", "false"],
];
const STUDY = [
  ["速览", "false"],
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

test("侧边栏：确认启用前只有启用说明，点启用以后说明怎么打开视频", async ({ open, openSidePanel }) => {
  const from = await open(LAUNCHER);
  const panel = await openSidePanel(from);
  await waitIn(panel, "启用说明", `${appText}.includes("先看看简幕会读什么")`);
  assert.equal(await panel.evaluate(`document.querySelectorAll(".mode").length`), 0, "确认前没有模式切换");
  await tap(panel, ".activation .button");
  await waitIn(panel, "没有视频时的说明", `${appText}.includes("打开一个 B 站或 YouTube 视频")`);
  // 测试构建里 YouTube 开关打开；没给过授权，认不出视频的页面都带启用按钮。
  await waitIn(panel, "YouTube 的启用按钮", `[...document.querySelectorAll(".state-block .button")].map((node) => node.textContent.trim()).join() === "在 YouTube 上启用"`);
});

test("侧边栏：没登录时也读到视频信息，长视频进速览；字幕那块说明原因，给重试和导入字幕文件，标题用读到的", async (ctx) => {
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
  });
});

test("侧边栏：登录以后长视频进速览，还没有概览时下面接着字幕；搜索只留命中的段落并高亮", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const login = await openTab(from, PROBE.login, false);
  await closeTab(from, login);
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕列出来", `${textOf(".cue-text")}.includes("样例台词二")`);
    assert.deepEqual(await panel.evaluate(modes), SKIM);
    assert.equal(await panel.evaluate(`Boolean(document.querySelector(".skim .skim-transcript .cues"))`), true, "字幕摆在速览里");
    // 速览里的字幕不跟着播放滚动：知道播放位置以后出「回到当前句」，侧边栏没被拉下去。
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
    await tap(panel, "[aria-label='搜索字幕']");
    await panel.evaluate(`(() => { const input = document.querySelector(".search-input"); input.value = "台词二"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await waitIn(panel, "只留命中的段落", `document.querySelectorAll(".cue").length === 1 && document.querySelector(".cue mark")?.textContent === "台词二"`);
    assert.equal(await panel.evaluate(`document.querySelector(".cue mark")?.closest(".cue-line")?.textContent`), "样例台词二", "高亮落在第二行里");
    assert.equal(await panel.evaluate(textOf(".search-count")), "1 处");
  });
});

test("侧边栏：速览还没有概览时先摆官方总结；没设置 AI 服务时生成概览停用并写明原因", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await waitIn(panel, "官方总结", `${textOf(".guide-summary")}.includes("这是自造的样例总结。")`);
    await waitIn(panel, "生成概览停用", `(() => { const button = [...document.querySelectorAll(".button")].find((node) => node.textContent === "生成概览"); return button?.disabled === true; })()`);
    assert.ok((await panel.evaluate(textOf(".control-reason"))).includes("先在设置页设置 AI 服务"));
    assert.equal(await panel.evaluate(`document.querySelector(".mode-view")?.getAttribute("aria-label")`), "速览");
    assert.ok((await panel.evaluate(textOf(".outline-title"))).includes("样例小节"), "官方总结的提纲也在");
  });
});

const OPTIONS_PATH = "/pages/options.html";
const optionsView = `chrome.extension.getViews({ type: "tab" }).find((view) => view.location.pathname === ${JSON.stringify(OPTIONS_PATH)})`;
/** 设置页「AI 服务」一节的顶边在视口里的位置、页面滚了多少、地址里还带不带节名；设置页没开或没渲染出这一节时是 null。 */
const aiSectionAt = `(() => { const view = ${optionsView}; const top = view?.document.getElementById("ai-service")?.getBoundingClientRect().top; return top === undefined ? null : { top, scrolled: view.scrollY, hash: view.location.hash }; })()`;
const closeOptions = `chrome.runtime.getContexts({ contextTypes: ["TAB"] }).then((list) => Promise.all(list.filter((item) => new URL(item.documentUrl).pathname === ${JSON.stringify(OPTIONS_PATH)}).map((item) => chrome.tabs.remove(item.tabId)))).then(() => true)`;
const CONFIG_ACTION = `.notice[data-id="config"] .notice-action`;

test("侧边栏：没设置 AI 服务时点顶上那行的「打开设置」，设置页停在「AI 服务」一节；设置页开着、滚到底时再点一次也滚回那一节，不另开", async (ctx) => {
  await withVideo(ctx, async (panel, _from, tabId) => {
    await panel.evaluate(closeOptions);
    await waitIn(panel, "没设置的提示", `Boolean(document.querySelector(${JSON.stringify(CONFIG_ACTION)}))`);
    try {
      await tap(panel, CONFIG_ACTION);
      await waitIn(panel, "设置页停在 AI 服务", `(() => { const at = ${aiSectionAt}; return at !== null && at.top >= 0 && at.top <= 200 && at.scrolled > 0 && at.hash === ""; })()`);

      // 设置页滚到底，回到视频页：侧边栏跟着当前标签页，回到视频才又有那一行。
      const away = await panel.evaluate(`(() => { const view = ${optionsView}; view.scrollTo(0, view.document.documentElement.scrollHeight); return view.document.getElementById("ai-service").getBoundingClientRect().top; })()`);
      assert.ok(away < 0, `滚到底以后 AI 服务一节在视口上面：${away}`);
      await panel.evaluate(`chrome.tabs.update(${tabId}, { active: true }).then(() => true)`);
      await waitIn(panel, "回到视频页又有那一行", `Boolean(document.querySelector(${JSON.stringify(CONFIG_ACTION)}))`);
      await tap(panel, CONFIG_ACTION);
      await waitIn(panel, "再点一次滚回 AI 服务", `(() => { const at = ${aiSectionAt}; return at !== null && at.top >= 0 && at.top <= 200 && at.hash === ""; })()`);
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

test("侧边栏：底部的提问入口只打开问答抽屉，不切模式、不发请求；没设置 AI 服务时提问停用，还没有问答时说明怎么用", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    assert.equal(await panel.evaluate(`${qaSheet}?.open`), false);
    await tap(panel, ".ask-entry");
    await waitIn(panel, "问答抽屉打开", `${qaSheet}?.open === true`);
    await waitIn(panel, "问答的空状态", `${appText}.includes("还没有问答")`);
    assert.equal(await panel.evaluate(`document.querySelector(".qa-form .button").disabled`), true);
    assert.ok((await panel.evaluate(textOf(".qa-form .control-reason"))).includes("先在设置页设置 AI 服务"));
    assert.deepEqual(await panel.evaluate(modes), SKIM, "开抽屉不切模式");
    await panel.evaluate(`(${qaSheet}).querySelector(".overlay-head [aria-label='关闭']").click(), true`);
    await waitIn(panel, "抽屉关上", `${qaSheet}?.open === false`);
  });
});

test("侧边栏：头部的笔记按钮打开笔记层，列出本视频的笔记，能改能删，删完回到空状态", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await tap(panel, ".mode-row [aria-label='笔记']");
    await waitIn(panel, "笔记层打开", `document.querySelector(".layer")?.open === true`);
    await waitIn(panel, "笔记的空状态", `${appText}.includes("还没有笔记")`);
    const saved = await panel.evaluate(`chrome.runtime.sendMessage({ type: "notes.save", req: { video: ${JSON.stringify(VIDEO)}, atSec: 1, text: "页面测试记的一条" } })`);
    assert.equal(saved?.ok, true, JSON.stringify(saved));
    await waitIn(panel, "列出这条", `${textOf(".note-text")} === "页面测试记的一条"`);
    assert.equal(await panel.evaluate(textOf(".layer .toolbar-count")), "1 条");

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
test("侧边栏：主动切到精读立刻换、说一声记住了；同一频道再打开就进精读；设置页「清除记住的 UP 主」以后回到按时长进速览", async (ctx) => {
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
    // 从设置页「速览和精读」一节清掉记住的 UP 主。
    const options = await ctx.open("pages/options.html");
    await options.waitFor("速览和精读一节", `Boolean(document.querySelector("#modes .button"))`);
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
test("侧边栏：长视频在速览里连续播满 1 分钟切到精读，问答抽屉和草稿都留着；顶上一行「已切到精读」，点一下回速览、这次不再切", async (ctx) => {
  await withVideo(
    ctx,
    async (panel, _from, tabId) => {
      await waitIn(panel, "长视频进速览", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "速览"`);
      await tap(panel, ".ask-entry");
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
      assert.ok(await clickText(panel, ".notice-action", "回到速览"));
      await waitIn(panel, "回到速览", `document.querySelector(".mode-view")?.getAttribute("aria-label") === "速览"`);
      await waitIn(panel, "这一行消失", `!${textOf(".notice-text")}.includes("已切到精读")`);
      const after = await panel.evaluate(`chrome.storage.session.get(${JSON.stringify(WATCH_SESSIONS_KEY)})`);
      assert.equal(after[WATCH_SESSIONS_KEY]?.[String(tabId)]?.autoSwitched, true, "这次观看记着切过，不再切");
    },
    PLAYING_SAMPLE.id,
    playingWatchPage(PLAYING_SAMPLE.id),
  );
}, { timeoutMs: 150_000 });
