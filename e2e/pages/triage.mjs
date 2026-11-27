// 粗筛页：读稍后再看、读完直接摆出第一步的确认、第一步取官方总结、没设置模型服务时第二步不开始并给「打开设置」（设置页停在 AI 服务那一节）、
// 「关掉这个页面……」只在进行中或等确认时显示、按判断筛选，重新打开时直接显示读过的、不自动弹确认；
// 语言选 English 以后页面上的字是英文，读列表失败时的说明也是英文，切回中文马上恢复；选繁体时读列表失败的说明是繁体。
// 排在侧边栏之后：那时已经确认启用、登录了模拟的 B 站；页面测试里没有设置模型服务的密钥。
import assert from "node:assert/strict";
import { describe } from "../../src/core/errors.ts";
import { PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { FOURTH_VIDEO, watchLaterData } from "../fixtures.mjs";
import { PROBE } from "../mock-server.mjs";
import { TRIAGE_HANT } from "../../src/pages/triage/text-hant.ts";
import { charsIn, SIMPLIFIED_ONLY } from "../../tests/helpers/hant-chars.ts";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const WIDTH = 900;
// 只数稍后再看列表里的：样例视频表里还有别的步骤用的视频。
const TITLES = watchLaterData().list.map((item) => item.title);

/** 按文字找按钮，真实点击它中间。 */
async function clickButton(page, text) {
  const box = await page.call(
    `(text) => {
      const node = [...document.querySelectorAll("button")].find((button) => button.textContent.trim().startsWith(text) && !button.disabled);
      if (!node) throw new Error("找不到按钮 " + text);
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }`,
    text,
  );
  await page.clickAt(box.x, box.y);
}

const statusOf = (page, id) => page.evaluate(`document.querySelector("#${id} .status")?.textContent ?? ""`);

async function statusHas(page, id, text, timeoutMs) {
  try {
    await page.waitFor(`状态行出现「${text}」`, `(document.querySelector("#${id} .status")?.textContent ?? "").includes(${JSON.stringify(text)})`, timeoutMs);
  } catch (error) {
    throw new Error(`${error.message}；状态行是「${await statusOf(page, id)}」`);
  }
  return statusOf(page, id);
}

const rows = (page) =>
  page.evaluate(`[...document.querySelectorAll(".video")].map((row) => ({ video: row.dataset.video, group: row.dataset.group, text: row.innerText }))`);

const OPTIONS_PATH = "/pages/options.html";
const optionsView = `chrome.extension.getViews({ type: "tab" }).find((view) => view.location.pathname === ${JSON.stringify(OPTIONS_PATH)})`;
/** 设置页「AI 服务」一节的顶边在视口里的位置；设置页没开或没渲染出这一节时是 null。 */
const aiSectionTop = `(() => { const view = ${optionsView}; const top = view?.document.getElementById("ai-service")?.getBoundingClientRect().top; return top === undefined ? null : top; })()`;
const closeOptions = `chrome.runtime.getContexts({ contextTypes: ["TAB"] }).then((list) => Promise.all(list.filter((item) => new URL(item.documentUrl).pathname === ${JSON.stringify(OPTIONS_PATH)}).map((item) => chrome.tabs.remove(item.tabId)))).then(() => true)`;
const hasCloseNote = `document.querySelector("#triage-steps .note") !== null`;

test("粗筛页：读列表、读完直接确认第一步、取官方总结、没设置模型服务时第二步不开始、按判断筛选", async ({ open }) => {
  const page = await open(PAGE_PATHS.triage, { width: WIDTH });
  await page.waitFor("读取按钮出来", `[...document.querySelectorAll("button")].some((button) => button.textContent.includes("读取我的稍后再看"))`);
  assert.equal(await page.evaluate(`document.querySelector("#triage-steps") === null`), true, "读列表之前没有两步");

  await clickButton(page, "读取我的稍后再看");
  await statusHas(page, "triage-list", `共 ${TITLES.length} 个视频`);
  const listed = await rows(page);
  assert.deepEqual(
    listed.map((row) => TITLES.find((title) => row.text.includes(title))),
    TITLES,
  );

  // 读完就摆出第一步的确认，不用再点「开始取官方总结」；第一步不花额度，不摆计费提示。
  await page.waitFor("第一步的确认", `document.querySelector('#step-official .confirm') !== null`);
  const confirm = await page.evaluate(`document.querySelector(".confirm")?.innerText ?? ""`);
  assert.match(confirm, new RegExp(`要逐个请求 ${TITLES.length} 个视频的 B 站官方总结`));
  assert.match(confirm, /不调模型，不花 API 额度/);
  assert.equal(await page.evaluate(hasCloseNote), false, "第一步不花额度，等确认时不摆计费提示");
  await clickButton(page, "现在开始");
  await statusHas(page, "step-official", "这一轮取完了", 20_000);
  assert.equal(await page.evaluate(hasCloseNote), false, "做完以后不再摆费用提示");
  const fetched = await rows(page);
  const fourth = fetched.find((row) => row.text.includes(FOURTH_VIDEO.title));
  assert.match(fourth?.text ?? "", /没有官方总结/);
  assert.match(fourth?.text ?? "", /去视频页生成概览/);
  for (const row of fetched.filter((entry) => entry !== fourth)) assert.match(row.text, /B 站官方总结：/);

  await clickButton(page, "开始写结论");
  await statusHas(page, "step-verdict", "还没设置好 AI 服务");
  assert.equal(await page.evaluate(`document.querySelector(".confirm") === null`), true, "没设置好时不弹确认");
  await page.evaluate(closeOptions);
  try {
    await clickButton(page, "打开设置");
    await page.waitFor("设置页停在 AI 服务", `(() => { const top = ${aiSectionTop}; return top !== null && top > -1 && top <= 200; })()`);
  } finally {
    await page.evaluate(closeOptions);
  }

  const counts = await page.evaluate(`[...document.querySelectorAll("button.filter")].map(button => [button.dataset.group, Number(button.textContent.trim().split(" ").at(-1))])`);
  assert.deepEqual(counts, [
    ["all", TITLES.length], ["5", 0], ["4", 0], ["3", 0], ["2", 0], ["1", 0], ["pending", TITLES.length], ["unknown", 0],
  ]);
  await clickButton(page, "还没判断");
  assert.equal((await rows(page)).length, TITLES.length);
  await clickButton(page, "可跳过");
  await page.waitFor("这一组是空的", `document.querySelector("#triage-results")?.innerText.includes("这一组还没有视频")`);
  assert.equal(await page.overflowsX(), false);
});

test("粗筛页：重新打开时直接显示读过的列表和官方总结；设置页有打开它的入口", async ({ open }) => {
  const page = await open(PAGE_PATHS.triage, { width: WIDTH });
  await page.waitFor("直接列出读过的", `document.querySelectorAll(".video").length === ${TITLES.length}`);
  assert.match(await statusOf(page, "triage-list"), /要看最新的列表就再读取一次/);
  assert.match(await statusOf(page, "step-official"), new RegExp(`有官方总结 ${TITLES.length - 1} 个，没有 1 个`));
  assert.equal(await page.evaluate(`document.querySelector(".confirm") === null`), true, "重新打开时不自动弹确认");
  assert.equal(await page.evaluate(hasCloseNote), false);

  const options = await open(PAGE_PATHS.options, { width: WIDTH });
  await options.waitFor("设置页有粗筛入口", `document.getElementById("openTriage") !== null`);
  assert.equal(await options.evaluate(`new URL(document.getElementById("openTriage").href).pathname`), `/${PAGE_PATHS.triage}`);
});

/** 在一个扩展页面里改设置里的语言选项：读出整份设置，只换这一项再写回。 */
const setLanguage = (page, language) =>
  page.evaluate(
    `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => chrome.storage.local.set({ ${JSON.stringify(SETTINGS_STORAGE_KEY)}: { ...(items[${JSON.stringify(SETTINGS_STORAGE_KEY)}] ?? {}), language: ${JSON.stringify(language)} } })).then(() => true)`,
  );

test("粗筛页：语言选 English 以后标题、各步、按钮、分组和视频行都换成英文，<html lang> 是 en，重新打开第一屏就是英文；切回中文马上恢复", async ({ open }) => {
  const page = await open(PAGE_PATHS.triage, { width: WIDTH });
  await page.waitFor("直接列出读过的", `document.querySelectorAll(".video").length === ${TITLES.length}`);
  const view = `({
    lang: document.documentElement.lang,
    title: document.title,
    heading: document.querySelector("h1")?.textContent,
    back: document.querySelector(".back-link")?.textContent,
    sections: [...document.querySelectorAll(".card h2")].map((node) => node.textContent),
    buttons: [...document.querySelectorAll(".actions button, .results-head button")].map((node) => node.textContent.trim()),
    filters: [...document.querySelectorAll(".filter")].map((node) => node.textContent.replace(/ \\d+$/, "")),
    status: document.querySelector("#triage-list .status")?.textContent ?? "",
  })`;
  await setLanguage(page, "en");
  try {
    await page.waitFor("界面换成英文", `document.documentElement.lang === "en"`);
    const english = await page.evaluate(view);
    assert.deepEqual({ ...english, status: undefined }, {
      lang: "en",
      title: "Watch Later triage · Jianmu",
      heading: "Watch Later triage",
      back: "Settings",
      sections: ["Read the list", "Step 1: Fetch Bilibili official summaries", "Step 2: Write one-line verdicts", "Results"],
      buttons: ["Load my Watch Later", "Fetch official summaries", "Write verdicts", "Export Markdown"],
      filters: ["All", "Must watch", "Worth watching", "Watch the key parts", "Mostly skippable", "Skip", "Not judged yet", "Not enough info"],
      status: undefined,
    });
    const fourth = (await rows(page)).find((row) => row.text.includes(FOURTH_VIDEO.title));
    assert.match(fourth?.text ?? "", /No official summary/);
    assert.match(fourth?.text ?? "", /Generate an overview on the video page/);

    // 首帧缓存记下了英文：重新打开时一出内容就是英文。
    const reopened = await open(PAGE_PATHS.triage, { width: WIDTH });
    await reopened.waitFor("重新打开后出现标题", `document.querySelector("h1") !== null`);
    assert.equal(await reopened.evaluate(`document.querySelector("h1").textContent`), "Watch Later triage");
    await reopened.waitFor("读出列表的状态行是英文", `(document.querySelector("#triage-list .status")?.textContent ?? "").includes("Read it again to get the latest list.")`);

    await setLanguage(page, "zh");
    await page.waitFor("界面换回中文", `document.documentElement.lang === "zh-CN"`);
    const chinese = await page.evaluate(view);
    assert.deepEqual({ ...chinese, status: undefined }, {
      lang: "zh-CN",
      title: "稍后再看粗筛 · 简幕",
      heading: "稍后再看粗筛",
      back: "设置",
      sections: ["读取列表", "第一步：取 B 站官方总结", "第二步：写一句话结论", "结果"],
      buttons: ["读取我的稍后再看", "开始取官方总结", "开始写结论", "导出 Markdown"],
      filters: ["全部", "推荐看", "值得看", "挑着看", "可略过", "可跳过", "还没判断", "信息不足"],
      status: undefined,
    });
  } finally {
    await setLanguage(page, "zh");
  }
});

test("粗筛页：English 下读列表失败时，说明的原因、影响和下一步是英文", async ({ open, openPage }) => {
  const page = await open(PAGE_PATHS.triage, { width: WIDTH });
  await page.waitFor("直接列出读过的", `document.querySelectorAll(".video").length === ${TITLES.length}`);
  // 在模拟的 B 站页面上把登录的 Cookie 清掉，读列表就说要先登录；做完重新登录，后面的测试照旧。
  const site = await openPage(PROBE.login);
  const [cookieName] = PROBE.cookie.split("=");
  await site.evaluate(`(document.cookie = ${JSON.stringify(`${cookieName}=; Domain=.bilibili.com; Path=/; Max-Age=0; Secure; SameSite=Lax`)}, true)`);
  await setLanguage(page, "en");
  try {
    await page.waitFor("界面换成英文", `document.documentElement.lang === "en"`);
    await clickButton(page, "Load my Watch Later");
    const expected = describe("NEED_LOGIN", undefined, "en");
    await statusHas(page, "triage-list", expected);
    assert.equal(await statusOf(page, "triage-list"), expected);
  } finally {
    await setLanguage(page, "zh");
    await openPage(PROBE.login);
  }
});

test("粗筛页：繁体下读列表失败时，说明的原因、影响和下一步是繁体，页面自己的字没有简体专用字", async ({ open, openPage }) => {
  const page = await open(PAGE_PATHS.triage, { width: WIDTH });
  await page.waitFor("直接列出读过的", `document.querySelectorAll(".video").length === ${TITLES.length}`);
  const site = await openPage(PROBE.login);
  const [cookieName] = PROBE.cookie.split("=");
  await site.evaluate(`(document.cookie = ${JSON.stringify(`${cookieName}=; Domain=.bilibili.com; Path=/; Max-Age=0; Secure; SameSite=Lax`)}, true)`);
  await setLanguage(page, "zh-Hant");
  try {
    await page.waitFor("界面换成繁体", `document.documentElement.lang === "zh-Hant"`);
    assert.equal(await page.evaluate(`document.querySelector("h1")?.textContent`), TRIAGE_HANT.heading);
    assert.match(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`), /PingFang TC/);
    await clickButton(page, TRIAGE_HANT.list.read);
    const expected = describe("NEED_LOGIN", undefined, "zh-Hant");
    assert.deepEqual(charsIn(expected, SIMPLIFIED_ONLY), []);
    await statusHas(page, "triage-list", expected);
    assert.equal(await statusOf(page, "triage-list"), expected);
    // 重新打开：一出内容就是繁体。视频标题是平台给的内容，不算；页面自己的字（列表以外的部分）没有简体专用字。
    // 已经显示着的状态行是切换语言之前按当时的语言写好的，换语言不重写（英文也一样），所以在新开的页面上看。
    const reopened = await open(PAGE_PATHS.triage, { width: WIDTH });
    await reopened.waitFor("直接列出读过的", `document.querySelectorAll(".video").length === ${TITLES.length} && document.documentElement.lang === "zh-Hant"`);
    const own = await reopened.evaluate(`(() => { const copy = document.body.cloneNode(true); copy.querySelectorAll(".video").forEach((node) => node.remove()); return copy.innerText; })()`);
    assert.deepEqual(charsIn(own, SIMPLIFIED_ONLY), [], own);
  } finally {
    await setLanguage(page, "zh");
    await openPage(PROBE.login);
  }
});
