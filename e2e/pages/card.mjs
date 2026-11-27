// 播放页卡片：刚打开时只露结论和前几章，结论排在官方总结前面，官方总结收成一行，章节名对得齐；
// 全部展开、最大字号、内容很长时，正文区滚动，标题栏、进度行和底部按钮都在框架高度上限以内；
// 密钥随浏览器重启清空时，说明直说要重新填（说法的规则在 pages/shared/config.ts，由单元测试守）；
// YouTube 上没有官方总结那一块，本机还没有字幕时不摆「生成概览」，请用户先在侧边栏读。
// 换过字幕时，依据旧字幕的结论标出来。
// 正文区什么都没有时不空出一块，按钮行接在头部下面。
// 官方总结晚到时，「生成概览」等它有了结果才摆，摆出来以后不被顶走；一直没结果时等够了照样摆。
// 收起的一行优先写判断理由，缺理由用摘要，没有结论时写播放到的章节，放不下就截断、不撑高，旁边是打开侧边栏的入口；侧边栏开着时不摆打开侧边栏的入口和按钮。
// 五套主题各自的版面下：图标和判断在展开收起时位置一致，底部的「重新生成」和主按钮在同一行两端。
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
import { verdictName } from "../../src/core/ai/verdict.ts";
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

test("卡片：刚打开结论在官方总结前面，官方总结收成一行，不重复视频标题；章节整份都在，列表只露前几章那么高、下一章露出大半并淡出，其余在列表里滚动，滚到底不再淡出、卡片不变高，焦点移到后面的章节时滚过去", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const read = () =>
    page.evaluate(`(() => {
      const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null;
      const fold = document.querySelector("#card-official .card-fold-head");
      const list = document.getElementById("card-chapters");
      const bottom = list?.getBoundingClientRect().bottom ?? 0;
      const rows = [...document.querySelectorAll("#card-overview .chapter")];
      return {
        text: document.getElementById("card").innerText,
        height: document.getElementById("card").getBoundingClientRect().height,
        chapters: rows.length,
        whole: rows.filter((row) => row.getBoundingClientRect().bottom <= bottom + 1).length,
        peek: rows[${CARD_ROWS}] ? rows[${CARD_ROWS}].getBoundingClientRect().top < bottom : false,
        count: document.querySelector("#card-overview .card-chapter-count")?.textContent ?? null,
        more: Boolean(document.getElementById("card-more")),
        scrollTop: list?.scrollTop ?? null,
        verdictTop: top("#card-overview .verdict"),
        officialTop: top("#card-official"),
        foldExpanded: fold?.getAttribute("aria-expanded") ?? null,
        outline: document.querySelectorAll("#card-official .outline-item").length,
      };
    })()`);

  const first = await read();
  assert.equal(first.chapters, 16, "章节整份都在");
  assert.equal(first.whole, CARD_ROWS, "整行露出来的是前几章");
  assert.equal(first.peek, true, "下一章露出来一截，看得出下面还有");
  assert.equal(await page.evaluate(`document.getElementById("card-chapters").hasAttribute("data-end")`), false, "下面还有时下沿淡出");
  assert.equal(first.count, "共 16 章");
  assert.equal(first.more, false, "章节不再有「展开全部」");
  assert.ok(first.verdictTop < first.officialTop, "结论排在官方总结前面");
  assert.equal(first.foldExpanded, "false");
  assert.equal(first.outline, 0, "官方总结收着，提纲不画出来");
  assert.ok(!first.text.includes("样例长视频"), "卡片里不再写视频标题");
  assert.ok(first.text.includes("B 站官方总结"));

  await page.evaluate(`(() => { const list = document.getElementById("card-chapters"); list.scrollTop = list.scrollHeight; return true; })()`);
  await page.waitFor("滚到底不再淡出", `document.getElementById("card-chapters").hasAttribute("data-end")`);
  const scrolled = await read();
  assert.ok(scrolled.scrollTop > 0, "列表自己滚");
  assert.equal(scrolled.height, first.height, "滚到底卡片不变高");

  await page.evaluate(`(() => { const list = document.getElementById("card-chapters"); list.scrollTop = 0; document.querySelectorAll("#card-overview .chapter-time")[15].focus(); return true; })()`);
  await page.waitFor("焦点移到最后一章，列表滚过去", `document.getElementById("card-chapters").scrollTop > 0`);

  await page.click("#card-official .card-fold-head");
  await page.waitFor("官方总结点开", `document.querySelectorAll("#card-official .outline-item").length === 12`);
  assert.equal((await read()).foldExpanded, "true");
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

test("卡片：收起的一行优先写理由，缺理由用摘要，没有结论时写播放到的章节，放不下就截断、不撑高；旁边是打开侧边栏的入口，侧边栏开着时没有", async ({ open }) => {
  const read = async (hash) => {
    const page = await open(`${SAMPLE}${hash}`);
    await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
    return page.evaluate(`(() => {
      const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; };
      const glance = document.getElementById("card-glance");
      return {
        height: Math.ceil(document.getElementById("card").getBoundingClientRect().height),
        name: document.querySelector(".card-name")?.textContent ?? "",
        verdict: document.querySelector(".card-verdict .verdict-name")?.textContent ?? null,
        ratingText: document.querySelector(".card-verdict")?.getAttribute("aria-label"),
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

  // 有结论、也知道播到哪：判断档后面写判断理由，不写章节；很长，截断成一行，卡片不变高；箭头和入口都在卡片里、不叠在一起。
  const glance = await read("#collapsed-glance");
  assert.equal(glance.verdict, "挑着看");
  assert.equal(glance.ratingText, "5 星中的 3 星，挑着看");
  assert.ok(glance.glance?.startsWith("中段的演示"), glance.glance);
  assert.equal(glance.cut, true, "放不下的结论截断");
  assert.equal(glance.height, CARD_HEIGHT.initial);
  assert.ok(glance.chevron.right <= glance.panel.left && glance.panel.right <= glance.card.right, JSON.stringify(glance));

  // 旧结论没有理由时写摘要，截断成一行，卡片不变高。
  const summary = await read("?reason=none#collapsed-verdict");
  assert.equal(summary.verdict, "挑着看");
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

  // 侧边栏开着时手动点开的：已有概览，「打开侧边栏」不摆，底部一行只剩「重新生成」。
  const opened = await read("#open-yield");
  assert.deepEqual([opened.buttons, opened.openPanel], [1, false]);
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

test("卡片：五套主题、浅色深色下，图标和判断在展开、收起时位置一致，展开时判断只出现一次，底部「重新生成」和主按钮在同一行两端", async ({ open }) => {
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
          logo: box(".card-logo"),
          logoImage: (() => { const img = document.querySelector(".card-logo"); return [img.getAttribute("src"), img.naturalWidth, img.width, img.height, img.alt, img.getAttribute("aria-hidden")]; })(),
          stars: box(".card-verdict .verdict-stars"),
          word: box(".card-verdict .verdict-name"),
          verdicts: document.querySelectorAll("#card .verdict-name").length,
          paragraphs: [...document.querySelectorAll(".verdict > p")].map(p => ({
            text: p.textContent, weight: getComputedStyle(p).fontWeight, size: getComputedStyle(p).fontSize,
            clipped: p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1,
          })),
          card: box("#card"),
          more: box("#card-regenerate"),
          moreText: document.getElementById("card-regenerate")?.textContent ?? null,
          panel: box("#card-panel"),
          primary: document.getElementById("card-panel")?.dataset.variant ?? null,
          headRow: document.querySelector(".card-head-row").getBoundingClientRect().height,
        };
      })()`);
      assert.equal(shown.head, "挑着看", label);
      assert.deepEqual(shown.logoImage, ["../icons/icon-32.png", 32, 16, 16, "", "true"], label);
      assert.ok(shown.logo.right <= shown.stars.left, label);
      assert.equal(shown.verdicts, 1, label);
      assert.deepEqual(shown.paragraphs.map(p => [p.weight, p.size, p.clipped]), [["500", "15px", false], ["400", "15px", false]], label);
      assert.match(shown.paragraphs[0].text, /^中段的演示/);
      assert.match(shown.paragraphs[1].text, /^这是一段自造的样例文字/);
      assert.ok(shown.headName.includes("简幕") && shown.headName.includes("挑着看"), `${label}：${shown.headName}`);
      assert.ok(!shown.head.includes("总结") && !shown.head.includes("·"), `${label}：${shown.head}`);
      assert.equal(shown.moreText, "重新生成", label);
      assert.equal(shown.primary, "primary", label);
      assert.ok(Math.abs(shown.more.middle - shown.panel.middle) < 2, `${label}：「重新生成」和「打开侧边栏」不在同一行 ${JSON.stringify(shown)}`);
      assert.ok(shown.more.right < shown.panel.left, `${label}：「重新生成」在左、按钮在右 ${JSON.stringify(shown)}`);
      assert.ok(shown.card.right - shown.panel.right < 20, `${label}：按钮靠右 ${JSON.stringify(shown)}`);

      await page.setReducedMotion(true);
      await page.click("#card-toggle");
      const line = await page.evaluate(`(() => {
        const glance = document.getElementById("card-glance");
        return {
          verdict: ${VISIBLE_TEXT}(document.querySelector(".card-verdict")),
          brand: ${VISIBLE_TEXT}(document.querySelector(".card-name")),
          positions: [".card-logo", ".card-verdict .verdict-stars", ".card-verdict .verdict-name"].map(selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return [r.left, (r.top + r.bottom) / 2];
          }),
          glance: ${VISIBLE_TEXT}(glance),
          oneLine: glance ? glance.scrollWidth > glance.clientWidth && glance.getBoundingClientRect().height < 30 : false,
          height: Math.ceil(document.getElementById("card").getBoundingClientRect().height),
          headRow: document.querySelector(".card-head-row").getBoundingClientRect().height,
        };
      })()`);
      // 展开和收起时头部一样高：点收起那一刻高度不往上跳。
      assert.equal(shown.headRow, line.headRow, `${label}：展开时头部高 ${shown.headRow}，收起时 ${line.headRow}`);
      assert.deepEqual(line.positions, [shown.logo, shown.stars, shown.word].map(r => [r.left, r.middle]), label);
      assert.equal(line.verdict, "挑着看", label);
      assert.equal(line.brand, "", `${label}：收起时不写名字`);
      assert.ok(line.glance?.startsWith("中段的演示"), `${label}：${line.glance}`);
      assert.equal(line.oneLine, true, `${label}：判断理由截成一行`);
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
      assert.ok(judged.head.startsWith("挑着看中段的演示"), `${label}：${judged.head}`);
      assert.equal(judged.name, "简幕", label);
      assert.equal(judged.height, CARD_HEIGHT.initial, label);
    }
  }
});

test("卡片：旧结论没有理由时，正文只显示常规字重的摘要", async ({ open }) => {
  const page = await open(`${SAMPLE}?reason=none`);
  const body = await page.evaluate(`[...document.querySelector(".verdict").children].map(node => [node.textContent, getComputedStyle(node).fontWeight])`);
  assert.equal(body.length, 1);
  assert.match(body[0][0], /^这是一段自造的样例文字/);
  assert.equal(body[0][1], "400");
});

test("卡片：各档的判断词和星采用对应字色，在五套主题的深浅底色上都能辨认", async ({ open }) => {
  for (const rating of [1, 2, 3, 4, 5, "unknown"]) {
    const page = await open(`${SAMPLE}?verdict=${rating}`);
    await page.setReducedMotion(true);
    for (const accentTheme of Object.keys(ACCENT_THEMES)) {
      for (const themeMode of ["light", "dark"]) {
        await page.setAppearance({ accentTheme, themeMode, uiFontScale: 100 });
        const band = accentTheme === "band";
        const unknown = rating === "unknown";
        const ink = unknown ? "var(--text-muted)" : rating <= 2 ? "var(--text)" : "var(--verdict)";
        const bandInk = unknown ? "var(--card-band-muted)" : rating <= 2 ? "var(--band-say)" : "var(--band-ink)";
        const colors = await page.call(`(expected) => {
          const probe = document.createElement("span");
          document.querySelector(".card-head-row").append(probe);
          probe.style.color = expected;
          const style = getComputedStyle(probe).color;
          probe.remove();
          return { expected: style, actual: [...document.querySelectorAll(".card-verdict .verdict-name, .card-verdict svg")].map(node => getComputedStyle(node).color) };
        }`, band ? bandInk : ink);
        const label = `${rating} ${accentTheme} ${themeMode}`;
        assert.deepEqual(colors.actual, Array(unknown ? 1 : 2).fill(colors.expected), label);
        assert.ok(await page.contrastOf(".card-verdict .verdict-name") >= 4.5, label);
        if (!unknown) assert.ok(await page.contrastOf(".card-verdict svg") >= 3, label);
        // 对比度工具读纯色背景。斜纹的两种底色各自量一次。
        if (band && unknown) {
          for (const stripe of ["--band-unknown", "--band-unknown-alt"]) {
            await page.call(`name => document.querySelector(".card-head-row").style.backgroundColor = "var(" + name + ")"`, stripe);
            assert.ok(await page.contrastOf(".card-verdict .verdict-name") >= 4.5, `${label} ${stripe}`);
          }
          await page.evaluate(`document.querySelector(".card-head-row").style.removeProperty("background-color")`);
        }
      }
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

test("卡片：结论带着评论区时，口碑那一行默认收着、点开露出要点，要点再点开露出原评论", async ({ open }) => {
  const page = await open(`${SAMPLE}#comments`);
  const read = () => page.evaluate(`(() => ({
    line: document.querySelector("#card-overview .comment-fold-head")?.textContent ?? "",
    expanded: document.querySelector("#card-overview .comment-fold-head")?.getAttribute("aria-expanded") ?? null,
    points: [...document.querySelectorAll("#card-comment-points .comment-point-text")].map((node) => node.textContent),
  }))()`);
  assert.deepEqual(await read(), { line: "评论 有争议 样例评论区的一句话", expanded: "false", points: [] });
  await page.evaluate(`(document.querySelector("#card-overview .comment-fold-head").click(), true)`);
  await page.waitFor("点开露出要点", `document.querySelectorAll("#card-comment-points .comment-point-text").length === 2`);
  assert.equal((await read()).expanded, "true");
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll(".comment-point summary")].map(node => node.querySelector(".comment-count")?.textContent ?? null)`), [null, "2 条评论"]);
  await page.evaluate(`(document.querySelector("#card-comment-points .comment-point summary").click(), true)`);
  await page.waitFor("要点点开露出原评论", `document.querySelector("#card-comment-points .comment-quote-text")?.textContent === "样例原评论一"`);
  assert.equal(await page.evaluate(`document.querySelector("#card-comment-points .comment-quote-meta")?.textContent ?? ""`), "置顶 · 赞 120");
});

test("卡片：评论还少且没有要点，或没读到评论时省去整行；只有有要点的行能点开并带箭头", async ({ open }) => {
  for (const [hash, visible, clickable] of [
    ["", false, false],
    ["#comments-few-only", false, false],
    ["#comments-only", true, false],
    ["#comments-few", true, true],
    ["#comments", true, true],
  ]) {
    const page = await open(`${SAMPLE}${hash}`);
    const row = await page.evaluate(`(() => {
      const line = document.querySelector("#card-overview .comment-line");
      const button = line?.closest("button");
      return [Boolean(line), Boolean(button), Boolean(document.querySelector("#card-overview .card-chevron"))];
    })()`);
    assert.deepEqual(row, [visible, clickable, clickable], hash);
  }
});

test("卡片：有官方总结、还没有结论时，结论该在的地方摆「用官方总结写结论」，排在官方总结前面；已经有结论、AI 服务没设置好时不摆", async ({ open }) => {
  const read = (page) => page.evaluate(`(() => {
    const offer = document.getElementById("card-official-verdict");
    const official = document.getElementById("card-official");
    return {
      text: offer?.textContent ?? "",
      before: Boolean(offer && official && offer.getBoundingClientRect().top < official.getBoundingClientRect().top),
    };
  })()`);
  assert.deepEqual(await read(await open(`${SAMPLE}#official`)), { text: "用官方总结写结论只发一次小请求，不通读字幕", before: true });
  assert.equal((await read(await open(SAMPLE))).text, "", "已经有结论");
  assert.equal((await read(await open(`${SAMPLE}#setup-key`))).text, "", "AI 服务没设置好");
});

test("卡片：已有概览时底部有「重新生成」，和「打开侧边栏」在同一行；点了在底部一行原来的位置摆出确认、看得见，刚才点的地方不是确认按钮，焦点在「取消」上，取消收回；缺了分块时正文里摆「补上缺的部分」", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.waitFor("摆出来", `Boolean(document.getElementById("card-regenerate"))`);
  const row = await page.evaluate(`["card-regenerate", "card-panel"].map((id) => { const box = document.getElementById(id).getBoundingClientRect(); return Math.round((box.top + box.bottom) / 2); })`);
  assert.ok(Math.max(...row) - Math.min(...row) <= 4, `不在同一行：${row}`);
  const askAt = await page.evaluate(`(() => { const box = document.getElementById("card-regenerate").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  await page.click("#card-regenerate");
  await page.waitFor("摆出确认", `Boolean(document.getElementById("card-regenerate-confirm"))`);
  const shown = await page.evaluate(`(() => {
    const confirm = document.querySelector("#card-regenerate-confirm .button[data-variant='primary']");
    const cancel = document.querySelector("#card-regenerate-confirm .button[data-variant='text']");
    const box = confirm.getBoundingClientRect();
    const at = ${JSON.stringify(askAt)};
    return {
      ask: Boolean(document.getElementById("card-regenerate")),
      note: document.querySelector("#card-regenerate-confirm .card-confirm-note")?.textContent ?? "",
      confirm: confirm.textContent,
      visible: box.top >= 0 && box.bottom <= window.innerHeight,
      underLastClick: at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom,
      focusOnCancel: document.activeElement === cancel,
    };
  })()`);
  assert.deepEqual(shown, { ask: false, note: "重新生成会再花一次 API 额度。", confirm: "确认重新生成", visible: true, underLastClick: false, focusOnCancel: true });
  await page.click("#card-regenerate-confirm .button[data-variant='text']");
  await page.waitFor("取消收回", `!document.getElementById("card-regenerate-confirm") && Boolean(document.getElementById("card-regenerate"))`);

  const failed = await open(`${SAMPLE}#failed-parts`);
  assert.equal(await failed.evaluate(`document.getElementById("card-failed-parts")?.textContent ?? ""`), "有一部分没生成出来，可以只补这部分。补上缺的部分");
  assert.equal(await page.evaluate(`Boolean(document.getElementById("card-failed-parts"))`), false, "没缺分块时不摆");
});

test("卡片：能提问时底部有提问框；合成的提交不发，真实按 Enter 才问，回答摆在框上面，回答里的时间点点了跳过去；不能提问时不摆", async ({ open }) => {
  assert.equal(await (await open(SAMPLE)).evaluate(`Boolean(document.getElementById("card-ask-input"))`), false, "不能提问的样张不摆");
  const page = await open(`${SAMPLE}#ask`);
  assert.equal(await page.evaluate(`document.getElementById("card-ask-input")?.placeholder ?? ""`), "针对这个视频提问，Enter 发送");
  await page.evaluate(`(() => {
    const input = document.getElementById("card-ask-input");
    input.value = "合成的问题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // 自己派发的提交事件才是合成的；requestSubmit() 发出的提交浏览器照样标成真实事件。
    input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  // 真实的提交在派发的同一刻就进了「正在回答」，所以这时没有它、框里的字也还在，就是没发。
  assert.deepEqual(await page.evaluate(`[document.getElementById("card-ask-input").value, Boolean(document.querySelector(".card-asking, #card-answer"))]`), ["合成的问题", false], "合成的提交不发");
  await page.evaluate(`(() => { const input = document.getElementById("card-ask-input"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  await page.click("#card-ask-input");
  await page.insertText("样例问题");
  await page.pressEnter();
  await page.waitFor("回答摆出来", `document.querySelector("#card-answer .card-answer-text")?.textContent === "样例回答在 1:30 讲到。"`);
  assert.equal(await page.evaluate(`document.querySelector("#card-answer .card-question")?.textContent ?? ""`), "样例问题");
  await page.click("#card-answer .card-stamp");
  await page.waitFor("跳到回答里的时间点", `window.__seeked === 90`);
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
  assert.equal(withOverview.chapters, 16, "章节整份都在，列表里滚动");
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
        more: document.querySelector("#card-overview .card-chapter-count")?.textContent ?? null,
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
      more: "16 chapters",
      official: "Bilibili official summary",
      buttons: ["Regenerate", "Open side panel"],
      toggle: "Collapse summary card",
    });
    const glance = await open(`${SAMPLE}#collapsed-glance`);
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict .verdict-name").textContent`), "Watch the key parts");
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict").getAttribute("aria-label")`), "3 out of 5 stars, Watch the key parts");
    assert.equal(await glance.evaluate(`document.getElementById("card-head-panel").textContent`), "Side panel");

    const comments = await open(`${SAMPLE}#comments`);
    assert.ok((await comments.evaluate(`document.querySelector(".card-comment-line").textContent`)).startsWith("Comments Divided "));

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
      more: "共 16 章",
      official: "B 站官方总结",
      buttons: ["重新生成", "打开侧边栏"],
      toggle: "收起总结卡片",
    });
    await glance.waitFor("收起的一行换回中文", `document.querySelector(".card-verdict .verdict-name").textContent === "挑着看"`);
  } finally {
    await setLanguage(options, "zh");
  }
});

test("卡片：英文界面、最大字号、右栏最窄时，星形保持字号，长判断词在头部换行不截断，收起按钮整个在卡片里；收起的一行高度不变，按钮和入口都露着、不叠", async ({ open }) => {
  const options = await open(PAGE_PATHS.options);
  await setLanguage(options, "en");
  await options.waitFor("设置页换成英文", `document.documentElement.lang === "en"`);
  try {
    // 三星的短词最长，二星和四星各含一个更长的英文单词。
    for (const rating of [2, 3, 4]) {
      for (const hash of ["", "#collapsed-verdict"]) {
        const page = await open(`pages/card-sample.html?verdict=${rating}${hash}`);
        await page.setWidth(NARROWEST, CARD_HEIGHT.max);
        for (const accentTheme of Object.keys(ACCENT_THEMES)) {
          await page.setAppearance({ accentTheme, themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
          const at = await page.evaluate(`(() => {
            const box = (selector) => { const node = document.querySelector(selector); if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom, height: r.height }; };
            const name = document.querySelector(".card-verdict .verdict-name");
            return {
              text: name?.textContent ?? "",
              clipped: name ? name.scrollWidth > name.clientWidth + 1 : true,
              ellipsis: name ? getComputedStyle(name).textOverflow === "ellipsis" : true,
              name: box(".card-verdict .verdict-name"),
              stars: box(".card-verdict .verdict-stars"),
              fontSize: parseFloat(getComputedStyle(name).fontSize),
              card: box("#card"),
              chevron: box(".card-collapse"),
              panel: box("#card-head-panel"),
              row: box(".card-head-row"),
              rowRem: 2.875 * parseFloat(getComputedStyle(document.documentElement).fontSize),
            };
          })()`);
          const label = `${accentTheme} ${rating} 星 ${hash || "展开"}：${JSON.stringify(at)}`;
          assert.equal(at.text, verdictName(rating, "en"), label);
          assert.ok(Math.abs(at.stars.height - at.fontSize) < 0.1 && Math.abs(at.stars.width - 5 * at.fontSize) < 0.1, `星形与短词同字号 ${label}`);
          assert.ok(at.stars.right <= at.name.left + 0.5 || at.stars.bottom <= at.name.top + 0.5, `短词排在星的旁边或下一行 ${label}`);
          assert.deepEqual([at.clipped, at.ellipsis], [false, false], `判断词没有被裁、没有省略号 ${label}`);
          assert.ok(at.chevron.left >= at.card.left && at.chevron.right <= at.card.right, `收起按钮整个在卡片里 ${label}`);
          assert.ok(at.name.right <= at.chevron.left + 0.5, `判断词不压在按钮上 ${label}`);
          assert.ok(Math.abs(at.row.height - at.rowRem) < 0.6, `头部高度不变 ${label}`);
          assert.ok(at.stars.top >= at.row.top - 0.5 && at.stars.bottom <= at.row.bottom + 0.5, `星形在这一行里 ${label}`);
          assert.ok(at.name.top >= at.row.top - 0.5 && at.name.bottom <= at.row.bottom + 0.5, `判断词在这一行里 ${label}`);
          if (hash) {
            assert.ok(at.panel && at.chevron.right <= at.panel.left + 0.5 && at.panel.right <= at.card.right, `「侧边栏」入口整个露着、不和按钮叠 ${label}`);
          }
        }
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
        more: document.querySelector("#card-overview .card-chapter-count")?.textContent ?? null,
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
      more: "共 16 章",
      official: "B 站官方總結",
      buttons: ["重新生成", "打開側邊欄"],
      toggle: "收合總結卡片",
    });
    assert.match(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`), /PingFang TC/);
    const glance = await open(`${SAMPLE}#collapsed-glance`);
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict .verdict-name").textContent`), verdictName(3, "zh-Hant"));
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict").getAttribute("aria-label")`), `5 星中的 3 星，${verdictName(3, "zh-Hant")}`);
    assert.deepEqual(simplifiedIn(await glance.evaluate(`document.getElementById("card-head-panel").textContent`)), []);

    const comments = await open(`${SAMPLE}#comments`);
    assert.ok((await comments.evaluate(`document.querySelector(".card-comment-line").textContent`)).startsWith("留言 有爭議 "));

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
    await glance.waitFor("收起的一行换回简体", `document.querySelector(".card-verdict .verdict-name").textContent === "挑着看"`);
  } finally {
    await setLanguage(options, "zh");
  }
});
