// 播放页卡片：刚打开时只露结论和前几章，结论排在官方总结前面，官方总结收成一行，章节名对得齐；
// 全部展开、最大字号、内容很长时，正文区滚动，标题栏、进度行和底部按钮都在框架高度上限以内；
// 密钥随浏览器重启清空时，说明直说要重新填（说法的规则在 pages/shared/config.ts，由单元测试守）；
// YouTube 上没有官方总结那一块，本机还没有字幕时不摆「生成概览」，请用户先在侧边栏读。
import assert from "node:assert/strict";
import { CARD_HEIGHT } from "../../src/content/card-frame.ts";
import { CARD_ROWS, NOT_READ_TEXT } from "../../src/pages/card/model.ts";
import { UI_FONT_SCALES } from "../../src/shared/settings-schema.ts";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const SAMPLE = "pages/card-sample.html";
// 右栏里卡片的宽度：和播放页右栏差不多，窄一点更容易撑高。
const FRAME_WIDTH = 320;

test("卡片：全部展开、框架高度到顶、最大字号、内容很长时，正文区滚动，进度行、「停止」和「打开侧边栏」都露在框架里", async ({ open }) => {
  const page = await open(`${SAMPLE}#full`);
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
      panelText: document.getElementById("card-panel")?.textContent ?? "",
      scrolls: body.scrollHeight > body.clientHeight,
    };
  })()`);
  assert.ok(measured.card <= CARD_HEIGHT.max, `卡片高 ${measured.card}，超过框架上限 ${CARD_HEIGHT.max}`);
  for (const key of ["head", "progress", "stop", "panel"]) {
    assert.ok(measured[key] <= measured.viewport, `${key} 的底边 ${measured[key]} 超出框架高度 ${measured.viewport}`);
  }
  assert.equal(measured.scrolls, true, "多出来的内容在正文区里滚动");
  assert.equal(measured.panelText, "打开侧边栏");
});

test("卡片：刚打开只露结论和前几章，结论在官方总结前面，官方总结收成一行，不重复视频标题；点「展开全部」和那一行才全露", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const read = () =>
    page.evaluate(`(() => {
      const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null;
      const fold = document.querySelector("#card-official .card-fold-head");
      return {
        text: document.getElementById("card").innerText,
        height: document.getElementById("card").getBoundingClientRect().height,
        chapters: document.querySelectorAll("#card-overview .chapter").length,
        more: document.querySelector("#card-overview .card-more")?.textContent ?? null,
        moreExpanded: document.querySelector("#card-overview .card-more")?.getAttribute("aria-expanded") ?? null,
        verdictTop: top("#card-overview .verdict"),
        officialTop: top("#card-official"),
        foldExpanded: fold?.getAttribute("aria-expanded") ?? null,
        outline: document.querySelectorAll("#card-official .outline-item").length,
      };
    })()`);

  const first = await read();
  assert.equal(first.chapters, CARD_ROWS);
  assert.equal(first.more, "展开全部 16 章");
  assert.equal(first.moreExpanded, "false");
  assert.ok(first.verdictTop < first.officialTop, "结论排在官方总结前面");
  assert.equal(first.foldExpanded, "false");
  assert.equal(first.outline, 0, "官方总结收着，提纲不画出来");
  assert.ok(!first.text.includes("样例长视频"), "卡片里不再写视频标题");
  assert.ok(first.text.includes("B 站官方总结"));

  await page.click("#card-overview .card-more");
  await page.waitFor("章节全露出来", `document.querySelectorAll("#card-overview .chapter").length === 16`);
  const all = await read();
  assert.equal(all.more, "收起");
  assert.equal(all.moreExpanded, "true");
  // 样张的章节名很长，露前几章时卡片可能已经到顶：展开以后不变矮，也不超过框架上限。
  assert.ok(all.height >= first.height);
  assert.ok(all.height <= CARD_HEIGHT.max);

  await page.click("#card-official .card-fold-head");
  await page.waitFor("官方总结点开", `document.querySelectorAll("#card-official .outline-item").length === 12`);
  assert.equal((await read()).foldExpanded, "true");

  await page.click("#card-overview .card-more");
  await page.waitFor("章节收回前几章", `document.querySelectorAll("#card-overview .chapter").length === ${CARD_ROWS}`);
});

test("卡片：官方总结的正文真被截了才给「展开全部」，按量出来的算不按字数猜；点了全露，再点收回", async ({ open }) => {
  const page = await open(`${SAMPLE}#official`);
  const read = () =>
    page.evaluate(`(() => {
      const reading = document.querySelector("#card-official .card-reading");
      return { more: document.querySelector("#card-official .card-more")?.textContent ?? null, hidden: reading.scrollHeight > reading.clientHeight + 1, clamp: reading.dataset.clamp ?? null };
    })()`);

  // 宽窄故意差得很开：测试机器上的字体和字宽不一定一样，这两档在哪套字体下结论都不变。
  // 很宽的卡片、标准字号：三行放得下，没有藏着的字，也就没有按钮。
  await page.setWidth(900, CARD_HEIGHT.max);
  await page.setAppearance({ accentTheme: "ink", themeMode: "light", uiFontScale: Math.min(...UI_FONT_SCALES) });
  await page.waitFor("量完", `!document.querySelector("#card-official .card-more")`);
  assert.deepEqual(await read(), { more: null, hidden: false, clamp: "true" });

  // 很窄的卡片、最大字号：同样的字三行放不下，按钮出现。
  await page.setWidth(200, CARD_HEIGHT.max);
  await page.setAppearance({ accentTheme: "ink", themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
  await page.waitFor("按钮出现", `document.querySelector("#card-official .card-more")?.textContent === "展开全部"`);
  assert.equal((await read()).hidden, true);

  await page.click("#card-official .card-more");
  await page.waitFor("正文全露", `document.querySelector("#card-official .card-more")?.textContent === "收起"`);
  assert.deepEqual(await read(), { more: "收起", hidden: false, clamp: null });
  await page.click("#card-official .card-more");
  await page.waitFor("收回三行", `document.querySelector("#card-official .card-more")?.textContent === "展开全部"`);
});

test("卡片：收起时整张卡片和载入前占位的高度一样，载入完右栏不跳", async ({ open }) => {
  const page = await open(`${SAMPLE}#collapsed`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const height = await page.evaluate(`Math.ceil(document.getElementById("card").getBoundingClientRect().height)`);
  assert.equal(height, CARD_HEIGHT.initial);
});

test("卡片：时间一列定宽，章节名从同一条线起，重点的圆点不把章节名顶歪；官方提纲的标题也对齐", async ({ open }) => {
  const page = await open(`${SAMPLE}#full`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const edges = await page.evaluate(`(() => {
    const lefts = (selector) => [...new Set([...document.querySelectorAll(selector)].map((node) => Math.round(node.getBoundingClientRect().left)))];
    const times = [...document.querySelectorAll("#card-overview .chapter-time")].map((node) => node.textContent);
    return {
      names: lefts("#card-overview .chapter-name"),
      keys: document.querySelectorAll("#card-overview .chapter[data-key]").length,
      short: times.some((time) => time.length === 4),
      long: times.some((time) => time.length === 5),
      outline: lefts("#card-official .outline-title"),
      points: lefts("#card-official .point > span:last-child"),
    };
  })()`);
  assert.equal(edges.keys, 2, "样张里有两章重点");
  assert.ok(edges.short && edges.long, "样张里四位和五位的时间都有");
  assert.equal(edges.names.length, 1, `章节名的左边不齐：${edges.names}`);
  assert.equal(edges.outline.length, 1, `官方提纲标题的左边不齐：${edges.outline}`);
});

test("卡片：配好过、密钥随浏览器重启清空时，说明直说要到设置页重新填密钥、提一句记住密钥，「打开设置」是主按钮，不摆「生成概览」", async ({ open }) => {
  const page = await open(`${SAMPLE}#setup-key`);
  const shown = await page.evaluate(`(() => ({
    setup: document.getElementById("card-setup")?.textContent ?? "",
    settings: document.getElementById("card-settings")?.getAttribute("data-variant") ?? null,
    generate: Boolean(document.getElementById("card-generate")),
  }))()`);
  assert.equal(shown.setup, "API 密钥随浏览器重启或扩展更新清空了，生成概览要先到设置页重新填；勾选「在这台电脑上记住密钥」就不用每次填。");
  assert.equal(shown.settings, "primary");
  assert.equal(shown.generate, false);
});

test("卡片（YouTube）：有概览时结论在最前、只露前几章，没有官方总结那一行；本机还没有字幕时不摆「生成概览」，说先在侧边栏读、给「重试」；字幕读过就和 B 站一样摆「生成概览」", async ({ open }) => {
  const read = (page) =>
    page.evaluate(`(() => ({
      text: document.getElementById("card").innerText,
      status: document.getElementById("card-status")?.textContent ?? null,
      chapters: document.querySelectorAll("#card-overview .chapter").length,
      verdict: Boolean(document.querySelector("#card-overview .verdict")),
      official: Boolean(document.getElementById("card-official")),
      buttons: [...document.querySelectorAll(".card-actions button")].map((button) => button.id),
    }))()`);

  const known = await open(`${SAMPLE}#youtube`);
  await known.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const withOverview = await read(known);
  assert.equal(withOverview.verdict, true, "结论摆出来");
  assert.equal(withOverview.chapters, CARD_ROWS);
  assert.equal(withOverview.official, false, "YouTube 没有官方总结，也不占一行去说");
  assert.ok(!withOverview.text.includes("官方总结"));
  assert.equal(withOverview.status, null, "有概览时不再提读字幕");
  assert.deepEqual(withOverview.buttons, ["card-panel"], "已经有概览：不摆「生成概览」，也用不着「重试」");

  const unread = await open(`${SAMPLE}#youtube-unread`);
  const empty = await read(unread);
  assert.equal(empty.status, NOT_READ_TEXT);
  assert.equal(empty.official, false);
  assert.deepEqual(empty.buttons, ["card-retry", "card-panel"], "本机没有字幕：卡片不去读，不摆「生成概览」");

  const ready = await open(`${SAMPLE}#youtube-ready`);
  assert.deepEqual((await read(ready)).buttons, ["card-generate", "card-panel"]);
});
