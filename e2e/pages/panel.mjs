// 测试工具自检：首次启用之前没法从播放页卡片点开侧边栏，页面测试从扩展页面带着用户手势打开真实的侧边栏。
// 侧边栏的场景接上以后，这一条由它们覆盖。
import assert from "node:assert/strict";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);

test("测试工具：在扩展页面里带用户手势打开真实的侧边栏，按地址接上它，页面能渲染", async ({ open, openSidePanel }) => {
  const from = await open("pages/gallery.html");
  const panel = await openSidePanel(from);
  const text = await panel.waitFor("侧边栏渲染出内容", `document.getElementById("app")?.textContent ?? ""`);
  assert.ok(text.length > 0);
  const head = await panel.evaluate(`[...document.head.querySelectorAll("script[src], link[rel='stylesheet']")].map((node) => node.getAttribute("src") ?? node.getAttribute("href"))`);
  assert.deepEqual(head.slice(0, 3), ["./theme-boot.js", "../theme.css", "../ui.css"]);
});
