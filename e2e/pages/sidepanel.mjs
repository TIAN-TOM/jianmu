// 侧边栏：确认启用前只有启用说明；没有视频时说明怎么用；视频页上读不到字幕、读到字幕、四个页签的主要状态。
// 页面测试里没有设置模型服务的密钥：概览和问答停在要先设置 AI 服务。
// 几个测试按顺序共用同一个浏览器：第一个确认启用，第二个还没登录，第三个起已登录。
import assert from "node:assert/strict";
import { describe as describeError } from "../../src/core/errors.ts";
import { videoKey } from "../../src/core/video-ref.ts";
import { VIDEOS } from "../fixtures.mjs";
import { PROBE, watchPage } from "../mock-server.mjs";
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

/** 侧边栏开在启动页的窗口里，再在侧边栏所在的窗口里打开视频页；做完关掉视频页。 */
async function withVideo({ open, openSidePanel }, fn) {
  const from = await open(LAUNCHER);
  const panel = await openSidePanel(from);
  const tabId = await openTab(panel, watchPage(FIRST_ID));
  try {
    // 同一个窗口的侧边栏会留到下一个测试，停在上一个测试的页签上，先回到字幕页签。
    await waitIn(panel, "页签出来", `Boolean(document.querySelector("#tab-transcript"))`);
    await tap(panel, "#tab-transcript");
    await fn(panel, from);
  } finally {
    await closeTab(from, tabId);
  }
}

/** 按条件等；等不到时把侧边栏上的文字带进报错，看得出停在哪。 */
async function waitIn(panel, label, expression) {
  try {
    return await panel.waitFor(label, expression);
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
  assert.equal(await panel.evaluate(`document.querySelectorAll("[role='tab']").length`), 0, "确认前没有页签");
  await tap(panel, ".activation .button");
  await waitIn(panel, "没有视频时的说明", `${appText}.includes("打开一个 B 站视频")`);
});

test("侧边栏：没登录时字幕页签说明原因，给重试和导入字幕文件，标题用标签页的", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "要登录的说明", `${appText}.includes(${JSON.stringify(describeError("NEED_LOGIN"))})`);
    const state = await panel.evaluate(`({
      tabs: [...document.querySelectorAll("[role='tab']")].map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]),
      actions: [...document.querySelectorAll(".state-block .button")].map((button) => button.textContent),
      title: document.querySelector(".video-title")?.textContent ?? "",
    })`);
    assert.deepEqual(state.tabs, [
      ["字幕", "true"],
      ["概览", "false"],
      ["笔记", "false"],
      ["问答", "false"],
    ]);
    assert.deepEqual(state.actions, ["重试", "导入字幕文件"]);
    assert.ok(state.title.includes(FIRST_TITLE), `视频信息读不到时用标签页的标题：${state.title}`);
  });
});

test("侧边栏：登录以后字幕页签列出字幕，搜索只留命中的段落并高亮", async (ctx) => {
  const from = await ctx.open(LAUNCHER);
  const login = await openTab(from, PROBE.login, false);
  await closeTab(from, login);
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕列出来", `${textOf(".cue-text")}.includes("样例台词二")`);
    assert.match(await panel.evaluate(textOf(".toolbar-count")), /^共 \d+ 段$/);
    await tap(panel, "[aria-label='搜索字幕']");
    await panel.evaluate(`(() => { const input = document.querySelector(".search-input"); input.value = "台词二"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await waitIn(panel, "只留命中的段落", `document.querySelectorAll(".cue").length === 1 && document.querySelector(".cue mark")?.textContent === "台词二"`);
    assert.equal(await panel.evaluate(textOf(".search-count")), "1 处");
  });
});

test("侧边栏：概览页签先摆官方总结；没设置 AI 服务时生成概览停用并写明原因", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await tap(panel, "#tab-overview");
    await waitIn(panel, "官方总结", `${textOf(".guide-summary")}.includes("这是自造的样例总结。")`);
    await waitIn(panel, "生成概览停用", `(() => { const button = [...document.querySelectorAll(".button")].find((node) => node.textContent === "生成概览"); return button?.disabled === true; })()`);
    assert.ok((await panel.evaluate(textOf(".control-reason"))).includes("先在设置页设置 AI 服务"));
    assert.equal(await panel.evaluate(`document.querySelector("#panel-overview")?.getAttribute("aria-labelledby")`), "tab-overview");
    assert.ok((await panel.evaluate(textOf(".outline-title"))).includes("样例小节"), "官方总结的提纲也在");
  });
});

test("侧边栏：问答页签没设置 AI 服务时提问停用，还没有问答时说明怎么用", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await tap(panel, "#tab-qa");
    await waitIn(panel, "问答的空状态", `${appText}.includes("还没有问答")`);
    assert.equal(await panel.evaluate(`document.querySelector(".qa-form .button").disabled`), true);
    assert.ok((await panel.evaluate(textOf(".qa-form .control-reason"))).includes("先在设置页设置 AI 服务"));
  });
});

test("侧边栏：笔记页签列出本视频的笔记，能改能删，删完回到空状态", async (ctx) => {
  await withVideo(ctx, async (panel) => {
    await waitIn(panel, "字幕读到", `document.querySelectorAll(".cue").length > 0`);
    await tap(panel, "#tab-notes");
    await waitIn(panel, "笔记的空状态", `${appText}.includes("还没有笔记")`);
    const saved = await panel.evaluate(`chrome.runtime.sendMessage({ type: "notes.save", req: { video: ${JSON.stringify(VIDEO)}, atSec: 1, text: "页面测试记的一条" } })`);
    assert.equal(saved?.ok, true, JSON.stringify(saved));
    await waitIn(panel, "列出这条", `${textOf(".note-text")} === "页面测试记的一条"`);
    assert.equal(await panel.evaluate(textOf(".toolbar-count")), "1 条");

    await tap(panel, ".note .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "编辑"));
    await waitIn(panel, "编辑框", `Boolean(document.querySelector(".note-input"))`);
    await panel.evaluate(`(() => { const input = document.querySelector(".note-input"); input.value = "改过的笔记"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    assert.ok(await clickText(panel, ".note-edit .button", "保存"));
    await waitIn(panel, "改好了", `${textOf(".note-text")} === "改过的笔记"`);

    await tap(panel, ".note .menu-anchor button");
    assert.ok(await clickText(panel, ".menu-item", "删除"));
    await waitIn(panel, "删完回到空状态", `${appText}.includes("还没有笔记")`);
  });
});
