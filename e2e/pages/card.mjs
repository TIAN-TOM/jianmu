// 播放页卡片：刚打开时只露结论和前几章，结论排在官方总结前面，官方总结收成一行，章节名对得齐；
// 全部展开、最大字号、内容很长时，正文区滚动，标题栏、进度行和底部按钮都在框架高度上限以内；
// 密钥随浏览器重启清空时，说明直说要重新填（说法的规则在 pages/shared/config.ts，由单元测试守）；
// YouTube 上没有官方总结那一块，本机还没有字幕时不摆「生成概览」，请用户先在侧边栏读。
// 换过字幕时，依据旧字幕的结论标出来。
// 官方总结晚到时，「生成概览」等它有了结果才摆，摆出来以后不被顶走；一直没结果时等够了照样摆。
// 收起的一行写着判断档和播放到的章节，放不下就截断、不撑高，旁边是打开侧边栏的入口；侧边栏开着时不摆打开侧边栏的入口和按钮。
// 展开收起有过渡：收起时内容留到过渡走完才拿掉，没有过渡时马上拿掉。
import assert from "node:assert/strict";
import { CARD_HEIGHT } from "../../src/content/card-frame.ts";
import { AUTO_FOLD_NOTE } from "../../src/pages/card/glance.ts";
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

test("卡片：展开收起有过渡，收起时内容留到过渡走完才拿掉、这期间点不到，高度一路往下走；再展开回到原来的高度；没有过渡时马上拿掉", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const height = `document.getElementById("card").getBoundingClientRect().height`;
  const settled = `document.getAnimations().every((item) => !(item instanceof CSSTransition))`;
  const full = await page.evaluate(height);
  assert.ok(full > CARD_HEIGHT.initial * 3, `展开着高 ${full} 像素`);

  // 点一下收起：标题栏马上换成收起的样子，下面那一块开始过渡；内容还在，但点不到。隔几帧高度已经在往下走。
  const closing = await page.evaluate(`(async () => {
    const frame = () => new Promise((done) => requestAnimationFrame(done));
    document.getElementById("card-toggle").click();
    await frame();
    const sheet = document.querySelector(".card-sheet");
    const first = {
      collapsed: document.getElementById("card").dataset.collapsed,
      open: sheet.dataset.open,
      body: document.getElementById("card-body") !== null,
      inert: sheet.firstElementChild.inert,
      moving: sheet.getAnimations().some((item) => item instanceof CSSTransition && item.transitionProperty === "grid-template-rows"),
    };
    await frame();
    await frame();
    await frame();
    return { ...first, later: ${height} };
  })()`);
  assert.deepEqual({ collapsed: closing.collapsed, open: closing.open, body: closing.body, inert: closing.inert, moving: closing.moving }, { collapsed: "true", open: "false", body: true, inert: true, moving: true });
  assert.ok(closing.later < full, `过渡开始几帧以后高 ${closing.later} 像素，展开着是 ${full}`);
  await page.waitFor("过渡走完，内容拿掉", `document.getElementById("card-body") === null && ${settled}`);
  assert.equal(Math.ceil(await page.evaluate(height)), CARD_HEIGHT.initial);

  // 再点一下展开：内容马上回来、点得到，高度长回原来那么高。
  await page.click("#card-toggle");
  await page.waitFor("展开的过渡走完", `document.querySelector(".card-sheet").dataset.open === "true" && document.getElementById("card-body") !== null && ${settled}`);
  assert.deepEqual(await page.evaluate(`({ height: ${height}, inert: document.querySelector(".card-sheet-in").inert })`), { height: full, inert: false });

  // 没有过渡（系统设了减少动效时各个时长都是零）：点收起以后内容马上拿掉，不等过渡结束的事件。
  await page.evaluate(`(document.documentElement.style.setProperty("--dur-mode", "0ms"), true)`);
  const instant = await page.evaluate(`(async () => {
    document.getElementById("card-toggle").click();
    await new Promise((done) => requestAnimationFrame(done));
    return { body: document.getElementById("card-body") !== null, height: Math.ceil(${height}) };
  })()`);
  assert.deepEqual(instant, { body: false, height: CARD_HEIGHT.initial });
});

test("卡片：收起的一行写判断档和播放到的章节，放不下就截断、不撑高；旁边是打开侧边栏的入口，侧边栏开着时没有", async ({ open }) => {
  const read = async (hash) => {
    const page = await open(`${SAMPLE}${hash}`);
    await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
    return page.evaluate(`(() => {
      const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; };
      const glance = document.getElementById("card-glance");
      return {
        height: Math.ceil(document.getElementById("card").getBoundingClientRect().height),
        name: document.querySelector(".card-name")?.textContent ?? "",
        glance: glance?.textContent ?? null,
        cut: glance ? glance.scrollWidth > glance.clientWidth : false,
        card: box("#card"),
        chevron: box("#card-toggle .card-chevron"),
        panel: box("#card-head-panel"),
        panelText: document.getElementById("card-head-panel")?.textContent ?? null,
        actions: Boolean(document.querySelector(".card-actions")),
        openPanel: Boolean(document.getElementById("card-panel")),
      };
    })()`);
  };

  // 还没读过：只有名字，入口照样在。
  const plain = await read("#collapsed");
  assert.deepEqual([plain.name, plain.glance, plain.panelText, plain.height], ["简幕 · 总结", null, "侧边栏", CARD_HEIGHT.initial]);

  // 读过、知道播到哪：判断档加「第几章 章节名」，章节名很长，截断成一行，卡片不变高；箭头和入口都在卡片里、不叠在一起。
  const glance = await read("#collapsed-glance");
  assert.equal(glance.name, "简幕 · 可以看");
  assert.match(glance.glance, /^11\/16 样例章节 11：/);
  assert.equal(glance.cut, true, "放不下的章节名截断");
  assert.equal(glance.height, CARD_HEIGHT.initial);
  assert.ok(glance.chevron.right <= glance.panel.left && glance.panel.right <= glance.card.right, JSON.stringify(glance));

  // 播满时长自动收起的那一下：先说一句为什么。
  const note = await read("#collapsed-note");
  assert.deepEqual([note.glance, note.height], [AUTO_FOLD_NOTE, CARD_HEIGHT.initial]);

  // 侧边栏开着、让位收起：不摆打开侧边栏的入口，箭头靠到最右边。
  const yielded = await read("#collapsed-yield");
  assert.equal(yielded.panel, null);
  assert.ok(yielded.card.right - yielded.chevron.right < 24, JSON.stringify(yielded));

  // 侧边栏开着时手动点开的：已有概览，按钮行只剩「打开侧边栏」一个按钮，它不摆，这一行就整个不摆。
  const opened = await read("#open-yield");
  assert.deepEqual([opened.actions, opened.openPanel], [false, false]);
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

test("卡片：换过字幕时结论块标「基于旧字幕」，章节和结论同一份依据只标一次；没换过时不标", async ({ open }) => {
  const read = (page) => page.evaluate(`(() => ({ basis: document.querySelector("#card-overview .verdict-basis")?.textContent ?? "", marks: (document.getElementById("card").innerText.match(/基于旧字幕/g) ?? []).length }))()`);
  const stale = await read(await open(`${SAMPLE}#stale`));
  assert.ok(stale.basis.includes("基于旧字幕"), stale.basis);
  assert.equal(stale.marks, 1);
  assert.equal((await read(await open(SAMPLE))).marks, 0);
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

test("卡片（YouTube）：有概览时结论在最前、只露前几章，没有官方总结那一行；没有代开文字稿的构建里本机还没有字幕时不摆「生成概览」，说先在侧边栏读、给「重试」；字幕读过就和 B 站一样摆「生成概览」", async ({ open }) => {
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
  assert.deepEqual(empty.buttons, ["card-retry", "card-panel"], "本机没有字幕（没有代开文字稿的构建）：卡片不去读，不摆「生成概览」");

  const ready = await open(`${SAMPLE}#youtube-ready`);
  assert.deepEqual((await read(ready)).buttons, ["card-generate", "card-panel"]);
});

test("卡片：官方总结晚到时，「生成概览」从第一次露出来到官方总结摆好，位置不变", async ({ open }) => {
  const page = await open(`${SAMPLE}#official-late`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  // 每一帧记一次按钮的位置：只要露过，就看它后来有没有被顶走。
  await page.evaluate(`(() => {
    window.__buttonTops = [];
    const tick = () => {
      const button = document.getElementById("card-generate");
      if (button) window.__buttonTops.push({ top: Math.round(button.getBoundingClientRect().top), official: Boolean(document.querySelector("#card-official .card-reading")) });
      requestAnimationFrame(tick);
    };
    tick();
    return true;
  })()`);
  await page.waitFor("官方总结摆出来，按钮也在", `Boolean(document.querySelector("#card-official .card-reading") && window.__buttonTops.some((entry) => entry.official))`);
  const tops = await page.evaluate(`window.__buttonTops`);
  assert.deepEqual([...new Set(tops.map((entry) => entry.top))].length, 1, `按钮被顶走过：${JSON.stringify(tops.map((entry) => entry.top).filter((top, at, all) => all.indexOf(top) === at))}`);
});

test("卡片：官方总结一直读不到时，先说正在读、不摆按钮行，等够了照样摆出「生成概览」", async ({ open }) => {
  const page = await open(`${SAMPLE}#official-never`);
  await page.waitFor("说正在读官方总结", `document.getElementById("card")?.innerText.includes("正在读 B 站的官方总结")`);
  assert.equal(await page.evaluate(`Boolean(document.querySelector(".card-actions"))`), false, "官方总结还在读：按钮行先不摆");
  await page.waitFor("等够了摆出「生成概览」", `Boolean(document.getElementById("card-generate"))`);
  assert.ok(await page.evaluate(`document.getElementById("card").innerText.includes("正在读 B 站的官方总结")`));
});
