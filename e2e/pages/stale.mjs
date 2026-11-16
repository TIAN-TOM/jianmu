// 旧后台、新页面：扩展装好以后改磁盘上各页面包里的构建标识，不重新加载扩展，后台还是装上时那一份。
// 每个页面打开后只显示重新加载的提示和按钮，不显示「这个页面不能做这件事」和连接断开的说法；按钮调的是重新加载扩展。
// 改的是磁盘上的文件，登记在最后。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_PATHS } from "../../src/shared/names.ts";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const PAGE_BUNDLES = ["sidepanel.js", "options.js", "triage.js", "card.js"];
const NEWER_BUILD = "0123456789abcdef";

/** 把各页面包里后台的那个构建标识换成另一个，换前核对每个包里都有。 */
function updatePagesOnDisk(dir) {
  const background = readFileSync(join(dir, "background.js"), "utf8");
  const current = background.match(/BUILD_ID = [^;]*?"([0-9a-f]{16})"/)?.[1];
  assert.ok(current, "后台包里有构建标识");
  assert.notEqual(current, NEWER_BUILD);
  for (const name of PAGE_BUNDLES) {
    const file = join(dir, "pages", name);
    const text = readFileSync(file, "utf8");
    assert.ok(text.includes(`"${current}"`), `${name} 和后台是同一个构建标识`);
    writeFileSync(file, text.replaceAll(`"${current}"`, `"${NEWER_BUILD}"`));
  }
}

const MISLEADING = /这个页面不能做这件事|断开|断了|计费/;

test("旧后台、新页面：粗筛页、设置页、侧边栏、卡片只显示重新加载的提示和按钮，按钮重新加载扩展", async ({ open, extensionDir }) => {
  updatePagesOnDisk(extensionDir);
  for (const path of [PAGE_PATHS.triage, PAGE_PATHS.options, PAGE_PATHS.sidepanel, PAGE_PATHS.card]) {
    const page = await open(path, { width: 900 });
    await page.waitFor(`${path} 显示重新加载的提示`, `document.querySelector(".state-title")?.textContent === "简幕需要重新加载"`);
    const text = await page.evaluate("document.body.innerText");
    assert.doesNotMatch(text, MISLEADING, `${path}：${text}`);
    const buttons = await page.evaluate(`[...document.querySelectorAll("button")].map((button) => button.textContent.trim())`);
    assert.deepEqual(buttons, ["重新加载简幕"], path);

    // 真重新加载会关掉全部扩展页面，这里换成记一笔，只核对按钮调的是它。
    await page.evaluate(`(() => { Object.defineProperty(chrome.runtime, "reload", { configurable: true, value: () => { globalThis.reloaded = (globalThis.reloaded ?? 0) + 1; } }); return true; })()`);
    await page.click(".state-actions button");
    await page.waitFor(`${path} 点按钮重新加载扩展`, "globalThis.reloaded === 1");
  }
});
