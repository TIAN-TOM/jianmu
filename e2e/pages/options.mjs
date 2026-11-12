// 设置页：确认启用之前只有启用说明和资料一节；确认以后能保存服务商、密钥和模型，拉模型列表、测试连接对着模拟的模型服务走通，
// 密钥只进会话存储；导出的备份清除全部数据后能再导回来。各测试开头先清除全部数据，从没启用的状态开始。
import assert from "node:assert/strict";
import { videoKey } from "../../src/core/video-ref.ts";
import { API_KEY_SESSION_KEY, PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { ANTHROPIC, VIDEOS } from "../fixtures.mjs";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const WIDTH = 900;
const [VIDEO_ID = ""] = Object.keys(VIDEOS);
const VIDEO = videoKey({ platform: "bilibili", videoId: VIDEO_ID, segment: 1 });

/** 发给后台一条消息，回后台的回复。 */
const send = (page, type, req) => page.call(`(type, req) => chrome.runtime.sendMessage({ type, req })`, type, req);

/** 清掉上一个测试留下的数据，另开一个设置页。 */
async function freshOptions(open) {
  const first = await open(PAGE_PATHS.options, { width: WIDTH });
  assert.deepEqual(await send(first, "data.clear", { scope: "all" }), { ok: true, value: {} });
  const page = await open(PAGE_PATHS.options, { width: WIDTH });
  await page.waitFor("显示启用说明", `document.querySelector(".activation") !== null`);
  return page;
}

/** 按文字找按钮，真实点击它中间。 */
async function clickButton(page, text, within = "body") {
  const box = await page.call(
    `(text, within) => {
      const node = [...document.querySelector(within).querySelectorAll("button")].find((button) => button.textContent.trim() === text);
      if (!node) throw new Error("找不到按钮 " + text);
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }`,
    text,
    within,
  );
  await page.clickAt(box.x, box.y);
}

/** 填输入框或选下拉框，按用户输入的样子发事件。 */
const fill = (page, selector, value) =>
  page.call(
    `(selector, value) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error("找不到 " + selector);
      node.focus();
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }`,
    selector,
    value,
  );

const statusOf = (page, section) => page.evaluate(`document.querySelector("#${section} .status")?.textContent ?? ""`);

/** 等某一节的状态行以这段文字开头；等不到时把当时的状态行写进报错。 */
async function statusStarts(page, section, prefix) {
  try {
    await page.waitFor(`状态行出现「${prefix}」`, `(document.querySelector("#${section} .status")?.textContent ?? "").startsWith(${JSON.stringify(prefix)})`);
  } catch (error) {
    throw new Error(`${error.message}；状态行是「${await statusOf(page, section)}」`);
  }
  return statusOf(page, section);
}

async function enable(page) {
  await clickButton(page, "启用简幕");
  await page.waitFor("确认启用后出现 AI 服务一节", `document.getElementById("preset") !== null`);
}

test("设置页：确认启用之前只有启用说明和资料一节，确认以后才有 AI 服务和外观", async ({ open }) => {
  const page = await freshOptions(open);
  const before = await page.evaluate(`({
    sections: [...document.querySelectorAll(".card > h2")].map((node) => node.textContent),
    hasPreset: document.getElementById("preset") !== null,
    buttons: [...document.querySelectorAll("#learning-data button")].map((node) => node.textContent.trim()),
  })`);
  assert.equal(before.hasPreset, false);
  assert.deepEqual(before.sections, ["学习资料"]);
  assert.deepEqual(before.buttons, ["导出备份", "清除缓存", "清除全部数据"], "确认前不能恢复备份");
  await enable(page);
  const after = await page.evaluate(`[...document.querySelectorAll(".card > h2")].map((node) => node.textContent)`);
  assert.deepEqual(after, ["外观", "播放页", "AI 服务", "稍后再看粗筛", "学习资料"]);
  assert.equal(await page.overflowsX(), false);
});

test("设置页：选服务商、填密钥、勾同意后保存，拉模型列表和测试连接对着模拟服务走通，密钥只进会话", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  await page.click("#dataConsent");
  await page.waitFor("同意记下了", `document.getElementById("dataConsent").checked`);

  await clickButton(page, "拉取模型列表");
  assert.equal(await statusStarts(page, "ai-service", "拉到"), "拉到 1 个模型，可以在模型框里直接选。");
  const listed = await page.evaluate(`[...document.querySelectorAll("#model-options option")].map((node) => node.value)`);
  assert.deepEqual(listed, [ANTHROPIC.model]);
  await fill(page, "#aiModel", ANTHROPIC.model);

  await clickButton(page, "保存并授权");
  assert.equal(await statusStarts(page, "ai-service", "已保存"), "已保存并授权。");
  await clickButton(page, "测试连接");
  assert.equal(await statusStarts(page, "ai-service", "默认模型"), `默认模型（${ANTHROPIC.model}）连接正常，回复「可用」`);

  const stored = await page.evaluate(`Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(${JSON.stringify(API_KEY_SESSION_KEY)})])`);
  const [local, session] = stored;
  assert.equal(local[SETTINGS_STORAGE_KEY].presetId, ANTHROPIC.presetId);
  assert.equal(local[SETTINGS_STORAGE_KEY].aiModel, ANTHROPIC.model);
  assert.equal(JSON.stringify(local).includes(ANTHROPIC.key), false, "没选记住，密钥不进本机存储");
  assert.equal(session[API_KEY_SESSION_KEY]?.key, ANTHROPIC.key);

  // 重新打开设置页，表单按存着的设置填回来。
  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor("重新打开后表单填回来", `document.getElementById("aiModel")?.value === ${JSON.stringify(ANTHROPIC.model)}`);
  assert.equal(await reopened.evaluate(`document.getElementById("aiApiKey").value`), ANTHROPIC.key);
});

test("设置页：导出的备份清除全部数据后能再导回来", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const saved = await send(page, "notes.save", { video: VIDEO, atSec: 30, text: "页面测试写的笔记" });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  await clickButton(page, "导出备份");
  await statusStarts(page, "learning-data", "已导出 1 条笔记");
  const exported = await send(page, "backup.export", {});
  assert.equal(exported.ok, true);

  await clickButton(page, "清除全部数据");
  await clickButton(page, "全部清除");
  await page.waitFor("清除完成，回到没启用", `document.querySelector("#learning-data .status").textContent.startsWith("已清除") && document.querySelector(".activation") !== null`);
  assert.deepEqual((await send(page, "notes.list", {})).code, "NOT_ENABLED");

  await enable(page);
  await page.call(
    `(text) => {
      const input = document.getElementById("backupImportInput");
      const files = new DataTransfer();
      files.items.add(new File([text], "backup.json", { type: "application/json" }));
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }`,
    JSON.stringify(exported.value),
  );
  assert.match(await statusStarts(page, "learning-data", "合并完成"), /笔记新增 1 条/);
  const notes = await send(page, "notes.list", {});
  assert.deepEqual(
    notes.value.notes.map((note) => note.text),
    ["页面测试写的笔记"],
  );
});
