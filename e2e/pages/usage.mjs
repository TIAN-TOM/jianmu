// 设置页「推理强度」一节的用量：会话存储里记着哪项功能最近一次的用量，那一项旁边就多一行字，开着页面时记下的也跟着出来；
// 「清除缓存」以后这几行连同存储一起没了。用量本身由后台在模型请求回来时写，单元测试覆盖，这里直接写一份自造的。
import assert from "node:assert/strict";
import { PAGE_PATHS, USAGE_STORAGE_KEY } from "../../src/shared/names.ts";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const WIDTH = 900;

/** 发给后台一条消息，回后台的回复。 */
const send = (page, type, req) => page.call(`(type, req) => chrome.runtime.sendMessage({ type, req })`, type, req);

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

const usageLines = `Object.fromEntries([...document.querySelectorAll("[data-usage]")].map((node) => [node.dataset.usage, node.textContent]))`;

test("设置页：推理强度那一节按功能显示最近一次的用量，开着页面时记下的也跟着出来；清除缓存以后没了", async ({ open }) => {
  const first = await open(PAGE_PATHS.options, { width: WIDTH });
  assert.deepEqual(await send(first, "data.clear", { scope: "all" }), { ok: true, value: {} });
  const page = await open(PAGE_PATHS.options, { width: WIDTH });
  await clickButton(page, "启用简幕");
  await page.waitFor("推理强度一节挂上", `document.querySelector('[data-effort="qa"]') !== null`);
  assert.deepEqual(await page.evaluate(usageLines), {}, "还没请求过，一行都没有");

  // 按后台算出的每项功能现在用的模型来写，那几行就不带模型名；概览那一项写成换过模型以前的。
  const preview = await send(page, "ai.effortPreview", {});
  assert.equal(preview.ok, true);
  const modelOf = (feature) => preview.value.items.find((item) => item.feature === feature)?.model ?? "";
  await page.call(
    `(key, value) => chrome.storage.session.set({ [key]: value }).then(() => true)`,
    USAGE_STORAGE_KEY,
    {
      qa: { model: modelOf("qa"), effort: "high", usage: { input: 12345, output: 2345, reasoning: 1800 } },
      verdict: { model: modelOf("verdict"), effort: "low", usage: { input: 900, output: 120 } },
      analysis: { model: "page-test-old-model", effort: "medium", usage: { input: 40000, output: 3000, reasoning: 0 } },
      explain: { model: modelOf("explain"), effort: "off", usage: {} },
    },
  );
  await page.waitFor("四行用量出来", `document.querySelectorAll("[data-usage]").length === 4`);
  assert.deepEqual(await page.evaluate(usageLines), {
    analysis: "最近一次（中，page-test-old-model）：输入 40,000 · 输出 3,000 · 思考 0",
    verdict: "最近一次（低）：输入 900 · 输出 120 · 思考没单独报",
    qa: "最近一次（高）：输入 12,345 · 输出 2,345 · 思考 1,800",
    explain: "最近一次（关）：服务没回报用量",
  });
  // 用量那一行在档位下拉框下面单独一行，不挤在下拉框旁边。
  const below = await page.evaluate(`(() => {
    const select = document.querySelector('[data-effort="qa"]').getBoundingClientRect();
    const line = document.querySelector('[data-usage="qa"]').getBoundingClientRect();
    return line.top >= select.bottom;
  })()`);
  assert.equal(below, true);
  assert.equal(await page.overflowsX(), false);

  await clickButton(page, "清除缓存");
  await clickButton(page, "清除缓存", "#learning-data .confirm");
  await page.waitFor("用量几行没了", `document.querySelectorAll("[data-usage]").length === 0`);
  const left = await page.evaluate(`chrome.storage.session.get(${JSON.stringify(USAGE_STORAGE_KEY)})`);
  assert.deepEqual(left, {}, "存储里也没了");
});
