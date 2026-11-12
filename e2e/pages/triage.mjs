// 粗筛页：读稍后再看、第一步取官方总结、没设置模型服务时第二步不开始、按判断筛选，重新打开时直接显示读过的。
// 排在侧边栏之后：那时已经确认启用、登录了模拟的 B 站；页面测试里没有设置模型服务的密钥。
import assert from "node:assert/strict";
import { PAGE_PATHS } from "../../src/shared/names.ts";
import { FOURTH_VIDEO, VIDEOS } from "../fixtures.mjs";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const WIDTH = 900;
const TITLES = Object.values(VIDEOS).map((video) => video.title);

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

test("粗筛页：读列表、第一步取官方总结、没设置模型服务时第二步不开始、按判断筛选", async ({ open }) => {
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

  await clickButton(page, "开始取官方总结");
  const confirm = await page.evaluate(`document.querySelector(".confirm")?.innerText ?? ""`);
  assert.match(confirm, new RegExp(`要逐个请求 ${TITLES.length} 个视频的 B 站官方总结`));
  assert.match(confirm, /不调模型，不花 API 额度/);
  await clickButton(page, "现在开始");
  await statusHas(page, "step-official", "这一轮取完了", 20_000);
  const fetched = await rows(page);
  const fourth = fetched.find((row) => row.text.includes(FOURTH_VIDEO.title));
  assert.match(fourth?.text ?? "", /没有官方总结/);
  assert.match(fourth?.text ?? "", /去视频页生成概览/);
  for (const row of fetched.filter((entry) => entry !== fourth)) assert.match(row.text, /B 站官方总结：/);

  await clickButton(page, "开始写结论");
  await statusHas(page, "step-verdict", "还没配置好 AI 服务");
  assert.equal(await page.evaluate(`document.querySelector(".confirm") === null`), true, "没设置好时不弹确认");

  await clickButton(page, "还没判断");
  assert.equal((await rows(page)).length, TITLES.length);
  await clickButton(page, "可以跳过");
  await page.waitFor("这一组是空的", `document.querySelector("#triage-results")?.innerText.includes("这一组还没有视频")`);
  assert.equal(await page.overflowsX(), false);
});

test("粗筛页：重新打开时直接显示读过的列表和官方总结；设置页有打开它的入口", async ({ open }) => {
  const page = await open(PAGE_PATHS.triage, { width: WIDTH });
  await page.waitFor("直接列出读过的", `document.querySelectorAll(".video").length === ${TITLES.length}`);
  assert.match(await statusOf(page, "triage-list"), /要看最新的列表就再读取一次/);
  assert.match(await statusOf(page, "step-official"), new RegExp(`有官方总结 ${TITLES.length - 1} 个，没有 1 个`));

  const options = await open(PAGE_PATHS.options, { width: WIDTH });
  await options.waitFor("设置页有粗筛入口", `document.getElementById("openTriage") !== null`);
  assert.equal(await options.evaluate(`new URL(document.getElementById("openTriage").href).pathname`), `/${PAGE_PATHS.triage}`);
});
