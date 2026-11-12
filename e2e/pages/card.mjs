// 播放页卡片：框架高度上限内、最大字号、内容很长时，正文区滚动，标题栏、进度行和底部按钮都在可见范围里。
import assert from "node:assert/strict";
import { CARD_HEIGHT } from "../../src/content/card-frame.ts";
import { UI_FONT_SCALES } from "../../src/shared/settings-schema.ts";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const SAMPLE = "pages/card-sample.html";
// 右栏里卡片的宽度：和播放页右栏差不多，窄一点更容易撑高。
const FRAME_WIDTH = 320;

test("卡片：框架高度到顶、最大字号、内容很长时，正文区滚动，进度行、「停止」和「打开完整面板」都露在框架里", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  await page.setAppearance({ accentTheme: "ink", themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
  const measured = await page.evaluate(`(() => {
    const bottom = (selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? Infinity;
    const body = document.querySelector(".card-body");
    const stop = [...document.querySelectorAll("#card-progress button")].find((button) => button.textContent.includes("停止"));
    return {
      card: document.getElementById("card").getBoundingClientRect().height,
      viewport: innerHeight,
      head: bottom("#card-toggle"),
      progress: bottom("#card-progress"),
      stop: stop ? stop.getBoundingClientRect().bottom : Infinity,
      panel: bottom("#card-panel"),
      scrolls: body.scrollHeight > body.clientHeight,
    };
  })()`);
  assert.ok(measured.card <= CARD_HEIGHT.max, `卡片高 ${measured.card}，超过框架上限 ${CARD_HEIGHT.max}`);
  for (const key of ["head", "progress", "stop", "panel"]) {
    assert.ok(measured[key] <= measured.viewport, `${key} 的底边 ${measured[key]} 超出框架高度 ${measured.viewport}`);
  }
  assert.equal(measured.scrolls, true, "多出来的内容在正文区里滚动");
});
