// 播放页卡片：刚打开时只露结论和前几章，结论排在官方总结前面，官方总结收成一行，章节名对得齐；
// 全部展开、最大字号、内容很长时，正文区滚动，标题栏、进度行和底部按钮都在框架高度上限以内；
// 密钥随浏览器重启清空时，说明直说要重新填（说法的规则在 pages/shared/config.ts，由单元测试守）；
// YouTube 上没有官方总结那一块，本机还没有字幕时不摆「生成概览」，请用户先在侧边栏读。
// 换过字幕时，依据旧字幕的结论标出来。
// 正文区什么都没有时不空出一块，按钮行接在头部下面。
// 官方总结晚到时，「生成概览」等它有了结果才摆，摆出来以后不被顶走；一直没结果时等够了照样摆。
// 收起的一行写着判断档和一句话结论（没有结论时写播放到的章节），放不下就截断、不撑高，旁边是打开侧边栏的入口；侧边栏开着时不摆打开侧边栏的入口和按钮。
// 五套主题各自的版面下：头部只写「简幕」，底部的「展开全部」和主按钮在同一行两端，收起的一行有判断词和一句话结论。
// 展开收起有过渡：收起时内容留到过渡走完才拿掉，没有过渡时马上拿掉。
// 语言选 English 以后卡片自己的字、报错和没设置好时的说明是英文，切回中文马上恢复；选繁体时同几处是繁体，判断档写繁体名。
import assert from "node:assert/strict";
import { CARD_HEIGHT } from "../../src/content/card-frame.ts";
import { describe } from "../../src/core/errors.ts";
import { cardSetupHint } from "../../src/pages/shared/config.ts";
import { PANEL_REFUSED_NOTE } from "../../src/pages/card/glance.ts";
import { CARD_ROWS, NOT_READ_TEXT } from "../../src/pages/card/model.ts";
import { PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { UI_FONT_SCALES } from "../../src/shared/settings-schema.ts";
import { VERDICT_HANT } from "../../src/core/ai/verdict-hant.ts";
import { charsIn, SIMPLIFIED_ONLY } from "../../tests/helpers/hant-chars.ts";
import { ACCENT_THEMES } from "../../src/shared/settings-schema.ts";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const SAMPLE = "pages/card-sample.html";
// 右栏里卡片的宽度：和播放页右栏差不多，窄一点更容易撑高。
const FRAME_WIDTH = 320;
// 卡片实际会有的最窄宽度：播放页右栏收到最窄时。
const NARROWEST = 300;

test("卡片：全部展开、框架高度到顶、最大字号、内容很长时，正文区滚动，进度行、「停止」和「打开侧边栏」都露在框架里", async ({ open }) => {
  const page = await open(`${SAMPLE}#full`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  await page.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
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
        more: document.getElementById("card-more")?.textContent ?? null,
        moreExpanded: document.getElementById("card-more")?.getAttribute("aria-expanded") ?? null,
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

  await page.click("#card-more");
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

  await page.click("#card-more");
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
  await page.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: Math.min(...UI_FONT_SCALES) });
  await page.waitFor("量完", `!document.querySelector("#card-official .card-more")`);
  assert.deepEqual(await read(), { more: null, hidden: false, clamp: "true" });

  // 很窄的卡片、最大字号：同样的字三行放不下，按钮出现。
  await page.setWidth(200, CARD_HEIGHT.max);
  await page.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
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
  await page.evaluate(`(["--dur-fast", "--dur", "--dur-mode"].forEach((name) => document.documentElement.style.setProperty(name, "0ms")), true)`);
  const instant = await page.evaluate(`(async () => {
    document.getElementById("card-toggle").click();
    await new Promise((done) => requestAnimationFrame(done));
    return { body: document.getElementById("card-body") !== null, height: Math.ceil(${height}) };
  })()`);
  assert.deepEqual(instant, { body: false, height: CARD_HEIGHT.initial });
});

test("卡片：收起的一行写判断档和一句话结论，没有结论时写播放到的章节，放不下就截断、不撑高；旁边是打开侧边栏的入口，侧边栏开着时没有", async ({ open }) => {
  const read = async (hash) => {
    const page = await open(`${SAMPLE}${hash}`);
    await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
    return page.evaluate(`(() => {
      const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; };
      const glance = document.getElementById("card-glance");
      return {
        height: Math.ceil(document.getElementById("card").getBoundingClientRect().height),
        name: document.querySelector(".card-name")?.textContent ?? "",
        verdict: document.querySelector(".card-verdict-name")?.textContent ?? null,
        glance: glance?.textContent ?? null,
        cut: glance ? glance.scrollWidth > glance.clientWidth : false,
        card: box("#card"),
        chevron: box("#card-toggle .card-collapse"),
        panel: box("#card-head-panel"),
        panelText: document.getElementById("card-head-panel")?.textContent ?? null,
        buttons: document.querySelectorAll(".card-actions .button").length,
        openPanel: Boolean(document.getElementById("card-panel")),
      };
    })()`);
  };

  // 还没读过：只有名字，入口照样在。
  const plain = await read("#collapsed");
  assert.deepEqual([plain.name, plain.verdict, plain.glance, plain.panelText, plain.height], ["简幕", null, null, "侧边栏", CARD_HEIGHT.initial]);

  // 有结论、也知道播到哪：判断档后面写一句话结论，不写章节；很长，截断成一行，卡片不变高；箭头和入口都在卡片里、不叠在一起。
  const glance = await read("#collapsed-glance");
  assert.equal(glance.verdict, "可以看");
  assert.ok(glance.glance?.startsWith("这是一段自造的样例文字"), glance.glance);
  assert.equal(glance.cut, true, "放不下的结论截断");
  assert.equal(glance.height, CARD_HEIGHT.initial);
  assert.ok(glance.chevron.right <= glance.panel.left && glance.panel.right <= glance.card.right, JSON.stringify(glance));

  // 有结论、不知道播到哪：同样是一句话结论，截断成一行，卡片不变高。
  const summary = await read("#collapsed-verdict");
  assert.equal(summary.verdict, "可以看");
  assert.ok(summary.glance?.startsWith("这是一段自造的样例文字"), summary.glance);
  assert.deepEqual([summary.cut, summary.height], [true, CARD_HEIGHT.initial]);

  // 只有章节、还没有结论：写「第几章 章节名」，没有判断档，章节名截断成一行。
  const chapters = await read("#collapsed-chapters");
  assert.equal(chapters.verdict, null);
  assert.match(chapters.glance, /^11\/16 样例章节 11：/);
  assert.deepEqual([chapters.cut, chapters.height], [true, CARD_HEIGHT.initial]);

  // 收起那一行上临时说一句话（打不开侧边栏时说的那句）：换掉结论，卡片不变高。
  const note = await read("#collapsed-note");
  assert.deepEqual([note.glance, note.height], [PANEL_REFUSED_NOTE, CARD_HEIGHT.initial]);

  // 侧边栏开着、让位收起：不摆打开侧边栏的入口，箭头靠到最右边。
  const yielded = await read("#collapsed-yield");
  assert.equal(yielded.panel, null);
  assert.ok(yielded.card.right - yielded.chevron.right < 24, JSON.stringify(yielded));

  // 侧边栏开着时手动点开的：已有概览，按钮只剩「打开侧边栏」一个，它不摆，底部一行只剩章节的「展开全部」。
  const opened = await read("#open-yield");
  assert.deepEqual([opened.buttons, opened.openPanel], [0, false]);
});

/** 一个元素里看得见的字：只给读屏的（剪成 1 像素的）不算。 */
const VISIBLE_TEXT = `((root) => {
  if (!root) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    let shown = getComputedStyle(node.parentElement).visibility !== "hidden";
    for (let item = node.parentElement; shown && item && item !== root.parentElement; item = item.parentElement) {
      const box = item.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) shown = false;
    }
    if (shown) text += node.textContent;
  }
  return text;
})`;

test("卡片：五套主题、浅色深色下，头部只写「简幕」，底部「展开全部」和主按钮在同一行两端；收起的一行有判断词和一句话结论", async ({ open }) => {
  for (const accentTheme of Object.keys(ACCENT_THEMES)) {
    for (const themeMode of ["light", "dark"]) {
      const label = `${accentTheme} ${themeMode}`;
      const page = await open(SAMPLE);
      await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
      await page.setAppearance({ accentTheme, themeMode, uiFontScale: Math.min(...UI_FONT_SCALES) });
      const shown = await page.evaluate(`(() => {
        const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, middle: (rect.top + rect.bottom) / 2 }; };
        return {
          head: ${VISIBLE_TEXT}(document.getElementById("card-toggle")),
          headName: document.getElementById("card-toggle").textContent,
          verdictFirst: document.querySelector(".card-verdict").getBoundingClientRect().left < document.querySelector(".card-brand").getBoundingClientRect().left,
          card: box("#card"),
          more: box("#card-more"),
          moreText: document.getElementById("card-more")?.textContent ?? null,
          panel: box("#card-panel"),
          primary: document.getElementById("card-panel")?.dataset.variant ?? null,
          headRow: document.querySelector(".card-head-row").getBoundingClientRect().height,
        };
      })()`);
      // 看不看那套的头部在色带里，判断词在前；别的几套头部只有名字。读屏的名称里名字和判断档都在。
      // 文字按标记的顺序连起来；看不看那套的判断词由样式表排到名字前面。
      assert.equal(shown.head, accentTheme === "band" ? "简幕可以看" : "简幕", label);
      if (accentTheme === "band") assert.equal(shown.verdictFirst, true, `${label}：判断词排在名字前面`);
      assert.ok(shown.headName.includes("简幕") && shown.headName.includes("可以看"), `${label}：${shown.headName}`);
      assert.ok(!shown.head.includes("总结") && !shown.head.includes("·"), `${label}：${shown.head}`);
      assert.equal(shown.moreText, "展开全部 16 章", label);
      assert.equal(shown.primary, "primary", label);
      assert.ok(Math.abs(shown.more.middle - shown.panel.middle) < 2, `${label}：「展开全部」和「打开侧边栏」不在同一行 ${JSON.stringify(shown)}`);
      assert.ok(shown.more.right < shown.panel.left, `${label}：「展开全部」在左、按钮在右 ${JSON.stringify(shown)}`);
      assert.ok(shown.card.right - shown.panel.right < 20, `${label}：按钮靠右 ${JSON.stringify(shown)}`);

      const mini = await open(`${SAMPLE}#collapsed-verdict`);
      await mini.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
      await mini.setAppearance({ accentTheme, themeMode, uiFontScale: Math.min(...UI_FONT_SCALES) });
      const line = await mini.evaluate(`(() => {
        const glance = document.getElementById("card-glance");
        return {
          verdict: ${VISIBLE_TEXT}(document.querySelector(".card-verdict")),
          brand: ${VISIBLE_TEXT}(document.querySelector(".card-brand")),
          glance: ${VISIBLE_TEXT}(glance),
          oneLine: glance ? glance.scrollWidth > glance.clientWidth && glance.getBoundingClientRect().height < 30 : false,
          height: Math.ceil(document.getElementById("card").getBoundingClientRect().height),
          headRow: document.querySelector(".card-head-row").getBoundingClientRect().height,
        };
      })()`);
      // 展开和收起时头部一样高：点收起那一刻高度不往上跳。
      assert.equal(shown.headRow, line.headRow, `${label}：展开时头部高 ${shown.headRow}，收起时 ${line.headRow}`);
      assert.equal(line.verdict, "可以看", label);
      assert.equal(line.brand, "", `${label}：收起时不写名字`);
      assert.ok(line.glance?.startsWith("这是一段自造的样例文字"), `${label}：${line.glance}`);
      assert.equal(line.oneLine, true, `${label}：一句话结论截成一行`);
      assert.equal(line.height, CARD_HEIGHT.initial, label);
    }
  }
});

test("卡片：五套主题、浅色深色下，收起时还没有判断档，头部照样看得见「简幕」，底色是卡片色、高度不变；有判断档时只看得见判断词和后面那句话", async ({ open }) => {
  for (const accentTheme of Object.keys(ACCENT_THEMES)) {
    for (const themeMode of ["light", "dark"]) {
      const label = `${accentTheme} ${themeMode}`;
      const read = async (hash) => {
        const page = await open(`${SAMPLE}${hash}`);
        await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
        await page.setAppearance({ accentTheme, themeMode, uiFontScale: Math.min(...UI_FONT_SCALES) });
        return page.evaluate(`(() => {
          const card = document.getElementById("card");
          const row = getComputedStyle(document.querySelector(".card-head-row")).backgroundColor;
          return {
            head: ${VISIBLE_TEXT}(document.getElementById("card-toggle")),
            name: document.querySelector(".card-name")?.textContent ?? null,
            nameColor: getComputedStyle(document.querySelector(".card-name")).color,
            expected: (() => { const probe = document.createElement("i"); probe.style.color = ${JSON.stringify(accentTheme === "marker" ? "var(--on-highlight)" : "var(--text)")}; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })(),
            row,
            plainRow: row === "rgba(0, 0, 0, 0)" || row === getComputedStyle(card).backgroundColor,
            height: Math.ceil(card.getBoundingClientRect().height),
          };
        })()`);
      };
      // 还没读过：没有判断档，名字照样在，头部不铺色带，文字是正文色（荧光笔那套是划过的字色）。
      const plain = await read("#collapsed");
      assert.equal(plain.head, "简幕", label);
      assert.equal(plain.height, CARD_HEIGHT.initial, label);
      assert.equal(plain.plainRow, true, `${label}：头部底色 ${plain.row}`);
      assert.equal(plain.nameColor, plain.expected, `${label}：名字的颜色`);
      // 有判断档：名字只给读屏，看得见的是判断词和后面那句话。
      const judged = await read("#collapsed-verdict");
      assert.ok(judged.head.startsWith("可以看这是一段自造的样例文字"), `${label}：${judged.head}`);
      assert.equal(judged.name, "简幕", label);
      assert.equal(judged.height, CARD_HEIGHT.initial, label);
    }
  }
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

test("卡片：换过字幕时结论块标「基于旧字幕」，章节和结论同一份依据只标一次；没换过时不标，也不写「依据字幕」", async ({ open }) => {
  const read = (page) => page.evaluate(`(() => ({ basis: document.querySelector("#card-overview .verdict-basis")?.textContent ?? "", marks: (document.getElementById("card").innerText.match(/基于旧字幕/g) ?? []).length }))()`);
  const stale = await read(await open(`${SAMPLE}#stale`));
  assert.ok(stale.basis.includes("基于旧字幕"), stale.basis);
  assert.equal(stale.marks, 1);
  assert.ok(!stale.basis.includes("依据字幕"), stale.basis);
  const fresh = await read(await open(SAMPLE));
  assert.equal(fresh.marks, 0);
  assert.equal(fresh.basis, "", "依据字幕是常态，卡片不标");
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
      buttons: [...document.querySelectorAll(".card-actions .button")].map((button) => button.id),
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

test("卡片：正文区什么都没有时（还没有概览、也没有官方总结）不空出一块，五套主题下按钮行和头部之间都只隔正文区顶上那一截", async ({ open }) => {
  const page = await open(`${SAMPLE}#youtube-ready`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  for (const accentTheme of Object.keys(ACCENT_THEMES)) {
    await page.setAppearance({ accentTheme, themeMode: "light", uiFontScale: Math.min(...UI_FONT_SCALES) });
    const measured = await page.evaluate(`(() => {
      const body = document.getElementById("card-body");
      return {
        empty: body.childElementCount === 0,
        bodyHeight: body.getBoundingClientRect().height,
        gap: document.getElementById("card-generate").getBoundingClientRect().top - document.querySelector(".card-head-row").getBoundingClientRect().bottom,
        bodyTop: parseFloat(getComputedStyle(body).paddingTop),
      };
    })()`);
    assert.equal(measured.empty, true, `${accentTheme}：这个样例的正文区本来就是空的`);
    assert.equal(measured.bodyHeight, 0, `${accentTheme}：空的正文区不占地方`);
    assert.ok(Math.abs(measured.gap - measured.bodyTop) < 1, `${accentTheme}：按钮行离头部 ${measured.gap}，应当和正文区顶上留的 ${measured.bodyTop} 一样`);
  }
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

/** 在一个扩展页面里改设置里的语言选项：读出整份设置，只换这一项再写回。 */
const setLanguage = (page, language) =>
  page.evaluate(
    `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => chrome.storage.local.set({ ${JSON.stringify(SETTINGS_STORAGE_KEY)}: { ...(items[${JSON.stringify(SETTINGS_STORAGE_KEY)}] ?? {}), language: ${JSON.stringify(language)} } })).then(() => true)`,
  );

test("卡片：语言选 English 以后，打开的卡片第一帧就是英文、<html lang> 是 en，判断档写英文名；切回中文马上恢复", async ({ open }) => {
  // 设置页开着：它落外观时把语言记进首帧缓存，卡片打开时读得到。
  const options = await open(PAGE_PATHS.options);
  await setLanguage(options, "en");
  await options.waitFor("设置页换成英文", `document.documentElement.lang === "en"`);
  try {
    const read = (page) =>
      page.evaluate(`(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        name: document.querySelector(".card-name")?.textContent ?? "",
        more: document.getElementById("card-more")?.textContent ?? null,
        official: document.querySelector("#card-official .card-fold-head span")?.textContent ?? null,
        buttons: [...document.querySelectorAll(".card-actions .button")].map((button) => button.textContent.trim()),
        toggle: document.getElementById("card-toggle")?.title ?? "",
      }))()`);
    const page = await open(SAMPLE);
    await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
    assert.deepEqual(await read(page), {
      lang: "en",
      title: "Jianmu summary card",
      name: "Jianmu",
      more: "Show all 16 chapters",
      official: "Bilibili official summary",
      buttons: ["Open side panel"],
      toggle: "Collapse summary card",
    });
    const glance = await open(`${SAMPLE}#collapsed-glance`);
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict-name").textContent`), "Watch the key parts");
    assert.equal(await glance.evaluate(`document.getElementById("card-head-panel").textContent`), "Side panel");

    // 报错和没设置好时的说法也是英文：读不到时的原因、影响、下一步，密钥清空时的说明。
    const failed = await open(`${SAMPLE}#load-failed`);
    const limited = describe("RATE_LIMITED", undefined, "en");
    await failed.waitFor("读不到时用英文说原因", `document.getElementById("card-status")?.textContent === ${JSON.stringify(limited)}`);
    const setup = await open(`${SAMPLE}#setup-key`);
    assert.equal(
      await setup.evaluate(`document.getElementById("card-setup")?.textContent ?? ""`),
      cardSetupHint({ state: "checked", view: { ready: false, errors: [], missing: "key" } }, "en"),
    );

    await setLanguage(options, "zh");
    await page.waitFor("卡片换回中文", `document.documentElement.lang === "zh-CN"`);
    assert.deepEqual(await read(page), {
      lang: "zh-CN",
      title: "简幕总结卡片",
      name: "简幕",
      more: "展开全部 16 章",
      official: "B 站官方总结",
      buttons: ["打开侧边栏"],
      toggle: "收起总结卡片",
    });
    await glance.waitFor("收起的一行换回中文", `document.querySelector(".card-verdict-name").textContent === "可以看"`);
  } finally {
    await setLanguage(options, "zh");
  }
});

test("卡片：英文界面、看不看、最大字号、右栏最窄时，最长的判断词在展开的头部里完整显示、换行不截断，收起按钮整个在卡片里；收起的一行高度不变，按钮和入口都露着、不叠", async ({ open }) => {
  const options = await open(PAGE_PATHS.options);
  await setLanguage(options, "en");
  await options.waitFor("设置页换成英文", `document.documentElement.lang === "en"`);
  try {
    // 四档加旧档位里英文最长的是「可以看」那一档。
    const longest = "Watch the key parts";
    for (const hash of ["", "#collapsed-verdict"]) {
      const page = await open(`pages/card-sample.html?verdict=${encodeURIComponent("可以看")}${hash}`);
      await page.setWidth(NARROWEST, CARD_HEIGHT.max);
      await page.setAppearance({ accentTheme: "band", themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
      const at = await page.evaluate(`(() => {
        const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height }; };
        const name = document.querySelector(".card-verdict-name");
        return {
          text: name?.textContent ?? "",
          clipped: name ? name.scrollWidth > name.clientWidth + 1 : true,
          ellipsis: name ? getComputedStyle(name).textOverflow === "ellipsis" : true,
          name: box(".card-verdict-name"),
          card: box("#card"),
          chevron: box(".card-collapse"),
          panel: box("#card-head-panel"),
          row: box(".card-head-row"),
          rowRem: 2.875 * parseFloat(getComputedStyle(document.documentElement).fontSize),
        };
      })()`);
      const label = `${hash || "展开"}：${JSON.stringify(at)}`;
      assert.equal(at.text, longest, label);
      assert.deepEqual([at.clipped, at.ellipsis], [false, false], `判断词没有被裁、没有省略号 ${label}`);
      assert.ok(at.chevron.left >= at.card.left && at.chevron.right <= at.card.right, `收起按钮整个在卡片里 ${label}`);
      assert.ok(at.name.right <= at.chevron.left + 0.5, `判断词不压在按钮上 ${label}`);
      if (hash) {
        assert.ok(Math.abs(at.row.height - at.rowRem) < 0.6, `收起的一行高度不变 ${label}`);
        assert.ok(at.name.top >= at.row.top - 0.5 && at.name.bottom <= at.row.bottom + 0.5, `判断词在这一行里 ${label}`);
        assert.ok(at.panel && at.chevron.right <= at.panel.left + 0.5 && at.panel.right <= at.card.right, `「侧边栏」入口整个露着、不和按钮叠 ${label}`);
      }
    }
  } finally {
    await setLanguage(options, "zh");
  }
});

test("卡片：语言选繁体以后，打开的卡片第一帧就是繁体、<html lang> 是 zh-Hant，判断档写繁体名，报错和没设置好时的说明是繁体；切回简体马上恢复", async ({ open }) => {
  const options = await open(PAGE_PATHS.options);
  await setLanguage(options, "zh-Hant");
  await options.waitFor("设置页换成繁体", `document.documentElement.lang === "zh-Hant"`);
  const simplifiedIn = (text) => charsIn(String(text ?? ""), SIMPLIFIED_ONLY);
  try {
    const read = (page) =>
      page.evaluate(`(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        name: document.querySelector(".card-name")?.textContent ?? "",
        more: document.getElementById("card-more")?.textContent ?? null,
        official: document.querySelector("#card-official .card-fold-head span")?.textContent ?? null,
        buttons: [...document.querySelectorAll(".card-actions .button")].map((button) => button.textContent.trim()),
        toggle: document.getElementById("card-toggle")?.title ?? "",
      }))()`);
    const page = await open(SAMPLE);
    await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
    // 第一帧：一打开就读，不等纠正。
    assert.deepEqual(await read(page), {
      lang: "zh-Hant",
      title: "簡幕總結卡片",
      name: "簡幕",
      more: "展開全部 16 章",
      official: "B 站官方總結",
      buttons: ["打開側邊欄"],
      toggle: "收合總結卡片",
    });
    assert.match(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`), /PingFang TC/);
    const glance = await open(`${SAMPLE}#collapsed-glance`);
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict-name").textContent`), VERDICT_HANT.fair);
    assert.deepEqual(simplifiedIn(await glance.evaluate(`document.getElementById("card-head-panel").textContent`)), []);

    const failed = await open(`${SAMPLE}#load-failed`);
    const limited = describe("RATE_LIMITED", undefined, "zh-Hant");
    assert.deepEqual(simplifiedIn(limited), []);
    await failed.waitFor("读不到时用繁体说原因", `document.getElementById("card-status")?.textContent === ${JSON.stringify(limited)}`);
    const setup = await open(`${SAMPLE}#setup-key`);
    const hint = cardSetupHint({ state: "checked", view: { ready: false, errors: [], missing: "key" } }, "zh-Hant");
    assert.deepEqual(simplifiedIn(hint), []);
    assert.equal(await setup.evaluate(`document.getElementById("card-setup")?.textContent ?? ""`), hint);

    await setLanguage(options, "zh");
    await page.waitFor("卡片换回简体", `document.documentElement.lang === "zh-CN"`);
    assert.equal(await page.evaluate(`document.querySelector(".card-name")?.textContent`), "简幕");
    await glance.waitFor("收起的一行换回简体", `document.querySelector(".card-verdict-name").textContent === "可以看"`);
  } finally {
    await setLanguage(options, "zh");
  }
});
