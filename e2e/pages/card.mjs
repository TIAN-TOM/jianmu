// 播放页卡片的正文、头部操作、生成进度、主题和语言。在真实的框架尺寸下检查位置和点击。
import assert from "node:assert/strict";
import { CARD_HEIGHT } from "../../src/content/card-frame.ts";
import { describe } from "../../src/core/errors.ts";
import { cardSetupHint } from "../../src/pages/shared/config.ts";
import { PANEL_REFUSED_NOTE } from "../../src/pages/card/glance.ts";
import { CARD_ROWS, NEED_LOGIN_TEXT, NOT_READ_TEXT } from "../../src/pages/card/model.ts";
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

// 换宽后，章节换行和正文滚动条都会触发重新测量。等第六章在列表下沿露出一截再读位置或点击后面的内容。
async function waitForChapterLayout(page) {
  await page.waitFor("章节列表按当前宽度排好", `(() => {
    const list = document.getElementById("card-chapters");
    const next = list?.querySelectorAll(".chapter")[${CARD_ROWS}]?.getBoundingClientRect();
    const bottom = list?.getBoundingClientRect().bottom;
    return next && next.top < bottom && bottom < next.bottom;
  })()`);
}

test("卡片：框架到顶时，更多操作和生成进度都在滚动正文上方，滚到底仍能停止", async ({ open }) => {
  const page = await open(`${SAMPLE}#full`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  await page.setAppearance({ accentTheme: "marker", themeMode: "light", uiFontScale: Math.max(...UI_FONT_SCALES) });
  await page.setReducedMotion(true);
  await page.click("#card-more-actions");
  const measured = await page.evaluate(`(() => {
    const box = selector => document.querySelector(selector).getBoundingClientRect();
    const body = document.querySelector(".card-body");
    body.scrollTop = body.scrollHeight;
    const stop = box("#card-progress button");
    return {
      height: box("#card").height,
      scroll: body.scrollTop,
      order: box(".card-head-row").bottom <= box("#card-tools").top && box("#card-tools").bottom <= box("#card-progress").top && box("#card-progress").bottom <= box(".card-body").top,
      stop: document.elementFromPoint(stop.left + stop.width / 2, stop.top + stop.height / 2)?.closest("#card-progress button")?.textContent,
      writing: document.querySelector(".card-progress-text").textContent,
      copies: document.getElementById("card").innerText.split("正在写一句话结论…").length - 1,
      footer: Boolean(document.querySelector(".card-actions, .card-body + *")),
    };
  })()`);
  assert.equal(measured.height, CARD_HEIGHT.max);
  assert.ok(measured.scroll > 0);
  assert.deepEqual([measured.order, measured.stop, measured.writing, measured.copies, measured.footer], [true, "停止", "正在写一句话结论…", 1, false]);
  await page.click("#card-progress button");
  await page.waitFor("点得到停止", `document.querySelector("#card-progress button").disabled && document.querySelector(".card-progress-text").textContent === "正在停止…"`);
});

test("卡片：刚打开只摆结论和章节，从更多操作打开官方总结，不重复视频标题；章节整份都在，列表只露前几章那么高、下一章露出大半并淡出，其余在列表里滚动，滚到底不再淡出、卡片不变高，焦点移到后面的章节时滚过去", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  await waitForChapterLayout(page);
  const read = () =>
    page.evaluate(`(() => {
      const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null;
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
        outline: document.querySelectorAll("#card-official .outline-item").length,
      };
    })()`);

  await waitForChapterLayout(page);
  const first = await read();
  assert.equal(first.chapters, 16, "章节整份都在");
  assert.equal(first.whole, CARD_ROWS, "整行露出来的是前几章");
  assert.equal(first.peek, true, "下一章露出来一截，看得出下面还有");
  assert.equal(await page.evaluate(`document.getElementById("card-chapters").hasAttribute("data-end")`), false, "下面还有时下沿淡出");
  assert.equal(first.count, "共 16 章");
  assert.equal(first.more, false, "章节不再有「展开全部」");
  assert.equal(first.officialTop, null, "官方总结收着时正文不留折叠行");
  assert.equal(first.outline, 0, "官方总结收着，提纲不画出来");
  assert.ok(!first.text.includes("样例长视频"), "卡片里不再写视频标题");
  assert.ok(!first.text.includes("B 站官方总结"));

  await page.evaluate(`(() => { const list = document.getElementById("card-chapters"); list.scrollTop = list.scrollHeight; return true; })()`);
  await page.waitFor("滚到底不再淡出", `document.getElementById("card-chapters").hasAttribute("data-end")`);
  const scrolled = await read();
  assert.ok(scrolled.scrollTop > 0, "列表自己滚");
  assert.equal(scrolled.height, first.height, "滚到底卡片不变高");
  const count = await page.evaluate(`(() => {
    const list = document.getElementById("card-chapters");
    const count = document.querySelector(".card-chapter-count");
    const range = document.createRange();
    range.selectNodeContents(count);
    return {
      rightGap: document.getElementById("card-overview").getBoundingClientRect().right - range.getBoundingClientRect().right,
      topGap: count.getBoundingClientRect().top - list.getBoundingClientRect().bottom,
      lastBottom: list.querySelector(".chapter:last-child").getBoundingClientRect().bottom,
      countTop: count.getBoundingClientRect().top,
    };
  })()`);
  assert.ok(Math.abs(count.rightGap) <= 1, "章数文字在列表下方靠正文右边");
  assert.ok(count.topGap >= 0 && count.topGap <= 5, "章数紧贴列表下方");
  assert.ok(count.lastBottom <= count.countTop + 1, "滚到底时章数不盖住最后一章");

  await page.evaluate(`(() => { const list = document.getElementById("card-chapters"); list.scrollTop = 0; document.querySelectorAll("#card-overview .chapter-time")[15].focus(); return true; })()`);
  await page.waitFor("焦点移到最后一章，列表滚过去", `document.getElementById("card-chapters").scrollTop > 0`);

  await page.setReducedMotion(true);
  await page.click("#card-more-actions");
  await page.click("#card-toggle-official");
  await page.waitFor("官方总结点开", `document.querySelectorAll("#card-official .outline-item").length === 12`);
  const expanded = await read();
  assert.ok(expanded.verdictTop < expanded.officialTop);
  assert.equal(await page.evaluate(`document.activeElement?.textContent`), "收起");
  await page.click("#card-official .card-link");
  assert.equal((await read()).officialTop, null);
  assert.equal((await page.focused())?.id, "card-more-actions");
  await page.click("#card-more-actions");
  await page.click("#card-toggle-official");
  await page.click("#card-more-actions");
  assert.equal(await page.evaluate(`document.getElementById("card-toggle-official").getAttribute("aria-expanded")`), "true");
  await page.click("#card-toggle-official");
  assert.equal((await read()).officialTop, null);
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
        panel: box("#card-panel"),
        panelText: document.getElementById("card-panel")?.textContent ?? null,
        more: Boolean(document.getElementById("card-more-actions")),
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

  // 侧边栏开着时手动点开，头部只多出更多操作。
  const opened = await read("#open-yield");
  assert.deepEqual([opened.panel, opened.more, yielded.more], [null, true, false]);
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

test("卡片：五套主题、浅色深色下，图标和判断在展开、收起时位置一致，展开时判断只出现一次，侧边栏和更多操作在头部右边", async ({ open }) => {
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
          more: box("#card-more-actions"),
          panel: box("#card-panel"),
          footer: Boolean(document.querySelector(".card-actions")),
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
      assert.equal(shown.footer, false, label);
      assert.ok(Math.abs(shown.more.middle - shown.panel.middle) < 2, label);
      assert.ok(shown.panel.right <= shown.more.left && shown.more.right <= shown.card.right, label);

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

test("卡片：五套主题的官方提纲和章节列表时间列等宽，竖线和标题起点对齐", async ({ open }) => {
  const page = await open(`${SAMPLE}#full`);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const assertAligned = (positions, label) => {
    const spread = Math.max(...positions) - Math.min(...positions);
    assert.ok(positions.length && spread <= 0.5, `${label}最多相差 ${spread} 个 CSS 像素`);
  };
  for (const accentTheme of Object.keys(ACCENT_THEMES)) {
    await page.setAppearance({ accentTheme, themeMode: "light", uiFontScale: 100 });
    const edges = await page.evaluate(`(() => {
      const nodes = (selector) => [...document.querySelectorAll(selector)];
      const chapters = nodes("#card-overview .chapter-time");
      const outline = nodes("#card-official .outline-item > .chapter-time");
      const titles = nodes("#card-official .outline-title");
      const cells = [...chapters, ...outline];
      const names = nodes("#card-overview .chapter-name");
      const keyTime = chapters.find((node) => node.closest(".chapter[data-key]") && node.textContent.length === 5);
      const range = document.createRange();
      range.selectNodeContents(keyTime);
      return {
        titleLefts: [...names, ...titles].map((node) => node.getBoundingClientRect().left),
        timeLefts: cells.map((node) => node.getBoundingClientRect().left),
        timeRights: cells.map((node) => node.getBoundingClientRect().right),
        borders: [...new Set(cells.map((node) => getComputedStyle(node).borderRightWidth))],
        outlineRows: outline.length,
        keyTimeFits: range.getClientRects().length === 1 && range.getBoundingClientRect().right <= keyTime.getBoundingClientRect().right + 0.5,
        keys: nodes("#card-overview .chapter[data-key]").length,
        lengths: [...new Set(chapters.map((node) => node.textContent.length))],
      };
    })()`);
    assert.equal(edges.keys, 2, "样张里有两章重点");
    assert.deepEqual(edges.lengths, [4, 5], "样张里四位和五位的时间都有");
    assert.ok(edges.outlineRows > 0, accentTheme);
    assert.equal(edges.titleLefts.length, edges.timeLefts.length, `${accentTheme}：每行都有标题和时间列`);
    assertAligned(edges.titleLefts, `${accentTheme}：提纲标题和章节名的左边`);
    assertAligned(edges.timeLefts, `${accentTheme}：时间列的左边`);
    assertAligned(edges.timeRights, `${accentTheme}：时间列的右边`);
    assert.equal(edges.borders.length, 1, `${accentTheme}：时间列的右边线一致`);
    if (accentTheme === "band") assert.ok(edges.keyTimeFits, "看不看主题的加粗五位时间完整放在时间列里");
  }
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

test("卡片：有官方总结时文字链接在生成旁边，确定没有字幕时仍然可以只用官方总结", async ({ open }) => {
  const read = (page) => page.evaluate(`(() => {
    const link = document.getElementById("card-official-verdict");
    return {
      link: link?.textContent ?? "",
      generateBefore: link?.previousElementSibling?.id === "card-generate",
      first: link?.parentElement === document.getElementById("card-body").firstElementChild,
      official: Boolean(document.querySelector("#card-official .card-reading")),
    };
  })()`);
  const text = "只用官方总结写一句（省额度）";
  assert.deepEqual(await read(await open(`${SAMPLE}#official`)), { link: text, generateBefore: true, first: true, official: true });
  const empty = await open(`${SAMPLE}#official-no-captions`);
  assert.deepEqual(await read(empty), { link: text, generateBefore: false, first: true, official: true });
  assert.equal(await empty.evaluate(`Boolean(document.getElementById("card-generate"))`), false);
  for (const [width, sameLine] of [[800, true], [NARROWEST, false]]) {
    await empty.setWidth(width, CARD_HEIGHT.max);
    const placement = await empty.evaluate(`(() => {
      const reason = document.getElementById("card-status");
      const link = document.getElementById("card-official-verdict");
      const lastLine = Array.from(reason.getClientRects()).at(-1);
      const box = link.getBoundingClientRect();
      return {
        followsReason: reason.nextElementSibling === link,
        sameLine: box.top < lastLine.bottom && box.bottom > lastLine.top,
      };
    })()`);
    assert.deepEqual(placement, { followsReason: true, sameLine }, `${width} 像素宽时，先说明没有字幕，文字链接在句后，放不下才换行`);
  }
  const verdictOnly = await open(`${SAMPLE}#verdict-only`);
  assert.deepEqual(await read(verdictOnly), { link: "", generateBefore: false, first: false, official: true });
  await verdictOnly.setReducedMotion(true);
  await verdictOnly.click("#card-more-actions");
  assert.deepEqual(await verdictOnly.evaluate(`[...document.querySelectorAll("#card-tools > button")].map(b => b.textContent)`), ["设置"]);
  assert.equal((await read(await open(SAMPLE))).link, "");
  assert.equal((await read(await open(`${SAMPLE}#setup-key`))).link, "");
});

test("卡片：读取失败、要登录或还没读 YouTube 字幕时，先说原因再给重试", async ({ open }) => {
  for (const [hash, reason] of [
    ["load-failed", describe("RATE_LIMITED", undefined, "zh")],
    ["need-login", NEED_LOGIN_TEXT],
    ["youtube-unread", NOT_READ_TEXT],
  ]) {
    const page = await open(`${SAMPLE}#${hash}`);
    await page.waitFor("重试紧跟原因", `document.querySelector("#card-status + #card-retry")?.previousElementSibling.textContent === ${JSON.stringify(reason)}`);
  }
});

test("卡片：更多操作紧贴头部、撑高卡片；Esc 和再点入口都能收起，焦点回到入口", async ({ open }) => {
  const page = await open(SAMPLE);
  await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
  const read = () => page.evaluate(`(() => {
    const toggle = document.getElementById("card-more-actions");
    return [toggle.getAttribute("aria-label"), toggle.getAttribute("aria-expanded"), document.getElementById("card").offsetHeight];
  })()`);
  const closed = await read();
  assert.deepEqual(closed.slice(0, 2), ["更多操作", "false"]);
  await page.click("#card-more-actions");
  await page.waitFor("操作区过渡走完", `Boolean(document.querySelector(".card-tools-sheet[data-settled]"))`);
  const opened = await read();
  assert.equal(opened[1], "true");
  assert.ok(opened[2] > closed[2]);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll("#card-tools > button")].map(b => b.textContent)`), ["重新生成会再花一次 API 额度", "B 站官方总结", "设置"]);
  await page.evaluate(`(document.getElementById("card-regenerate").focus(), document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))`);
  await page.waitFor("高度恢复", `document.getElementById("card").offsetHeight === ${closed[2]} && !document.getElementById("card-tools")`);
  assert.deepEqual(await read(), closed);
  assert.equal((await page.focused())?.id, "card-more-actions");
  await page.click("#card-more-actions");
  await page.click("#card-more-actions");
  assert.equal((await read())[1], "false");
  assert.equal((await page.focused())?.id, "card-more-actions");
});

test("卡片：重新生成确认先聚焦取消，刚出现时点击确认不花额度；取消回到操作列表，收起卡片撤掉确认", async ({ open }) => {
  const page = await open(`${SAMPLE}#regenerate`);
  await page.setReducedMotion(true);
  await page.waitFor("概览已经读到", `Boolean(document.getElementById("card-overview"))`);
  await page.click("#card-more-actions");
  const previous = await page.evaluate(`(() => { const r = document.getElementById("card-regenerate").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.click("#card-regenerate");
  const confirm = "#card-regenerate-confirm [data-variant='primary']";
  const cancel = "#card-regenerate-confirm [data-variant='text']";
  assert.deepEqual(await page.evaluate(`[
    document.querySelector(".card-confirm-note")?.textContent,
    document.querySelector("${confirm}")?.textContent,
    document.activeElement === document.querySelector("${cancel}"),
    Boolean(document.querySelector("#card-regenerate, #card-toggle-official"))
  ]`), ["重新生成会再花一次 API 额度。", "确认重新生成", true, false]);
  assert.equal(await page.evaluate(`document.elementFromPoint(${previous.x}, ${previous.y})?.closest("${confirm}") != null`), false, "确认按钮避开刚才点的位置");
  await page.evaluate(`(document.querySelector("${confirm}").addEventListener("click", e => { window.__confirmClicked = e.isTrusted; }, { once: true }), true)`);
  await page.click(confirm);
  assert.deepEqual(await page.evaluate(`[window.__confirmClicked, Boolean(document.querySelector("${confirm}"))]`), [true, true], "连点第二下不开始生成");
  await page.click(cancel);
  assert.equal((await page.focused())?.id, "card-regenerate");
  await page.click("#card-regenerate");
  await page.click("#card-toggle");
  await page.click("#card-toggle");
  await page.click("#card-more-actions");
  assert.equal(await page.evaluate(`Boolean(document.getElementById("card-regenerate"))`), true);

  const failed = await open(`${SAMPLE}#failed-parts`);
  assert.equal(await failed.evaluate(`document.querySelector("#card-failed-parts.card-note > .card-link")?.textContent`), "补上缺的部分");
  assert.equal(await page.evaluate(`Boolean(document.getElementById("card-failed-parts"))`), false);
});

test("卡片：能提问时发送图标在框里，空着点只聚焦，合成的点击和提交不发，按回车能发送；不能提问时不摆", async ({ open }) => {
  assert.equal(await (await open(SAMPLE)).evaluate(`Boolean(document.getElementById("card-ask-input"))`), false, "不能提问的样张不摆");
  const page = await open(`${SAMPLE}#ask`);
  await waitForChapterLayout(page);
  assert.equal(await page.evaluate(`document.getElementById("card-ask-input").placeholder`), "问这个视频，回车发送");
  assert.equal(await page.evaluate(`document.querySelector(".card-ask-send").getAttribute("aria-label")`), "发送");
  const inside = await page.evaluate(`(() => {
    const input = document.getElementById("card-ask-input");
    const box = input.getBoundingClientRect();
    const send = document.querySelector(".card-ask-send").getBoundingClientRect();
    return send.top >= box.top && send.bottom <= box.bottom && send.right <= box.right &&
      send.left >= box.right - parseFloat(getComputedStyle(input).paddingRight);
  })()`);
  assert.ok(inside, "图标在输入框右侧给它留的位置里");
  await page.click(".card-ask-send");
  assert.equal((await page.focused())?.id, "card-ask-input");
  assert.equal(await page.evaluate(`Boolean(document.querySelector(".card-asking, #card-answer"))`), false, "空着点发送不提问");
  await page.evaluate(`(() => {
    const input = document.getElementById("card-ask-input");
    input.value = "合成的问题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.form.querySelector("button").click();
    input.form.requestSubmit();
    input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  })()`);
  // 真实的提交在派发的同一刻就进了「正在回答」，所以这时没有它、框里的字也还在，就是没发。
  assert.deepEqual(await page.evaluate(`[document.getElementById("card-ask-input").value, Boolean(document.querySelector(".card-asking, #card-answer"))]`), ["合成的问题", false], "合成的提交不发");
  await page.evaluate(`(() => { const input = document.getElementById("card-ask-input"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  await waitForChapterLayout(page);
  await page.click("#card-ask-input");
  await page.insertText("样例问题");
  await page.pressEnter();
  await page.waitFor("回答摆出来", `document.querySelector("#card-answer .card-answer-text")?.textContent === "样例回答见1:30。"`);
  assert.equal(await page.evaluate(`document.querySelector("#card-answer .card-question")?.textContent ?? ""`), "样例问题");
});

test("卡片：点发送图标能提问，回答里的时间点贴着正文，行尾放不下句号时一起换行，点时间仍能跳", async ({ open }) => {
  const page = await open(`${SAMPLE}#ask`);
  await waitForChapterLayout(page);
  await page.click("#card-ask-input");
  await page.insertText("样例问题");
  await page.click(".card-ask-send");
  await page.waitFor("回答摆出来", `document.querySelector(".card-answer-text")?.textContent === "样例回答见1:30。"`);
  const measured = await page.evaluate(`(() => {
    const answer = document.querySelector(".card-answer-text");
    const stamp = answer.querySelector(".card-stamp");
    const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT);
    const prefix = walker.nextNode();
    let period;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent === "。") period = walker.currentNode;
    }
    const rect = (node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const before = rect(stamp);
    const leadingGap = before.left - rect(prefix).right;
    const trailingGap = rect(period).left - before.right;
    // 量到时间末尾再留半个句号宽，让行尾放得下时间、放不下整个句号。
    answer.style.width = (before.right - answer.getBoundingClientRect().left + rect(period).width / 2) + "px";
    const after = rect(stamp);
    const stop = rect(period);
    return { leadingGap, trailingGap, wrapped: after.top >= rect(prefix).bottom, together: stop.top < after.bottom && after.top < stop.bottom };
  })()`);
  assert.ok(Math.abs(measured.leadingGap) <= 1 && Math.abs(measured.trailingGap) <= 1, "时间点两侧紧贴正文");
  assert.ok(measured.wrapped, "时间点确实换到了下一行");
  assert.ok(measured.together, "句号跟时间点在同一行");
  await page.click("#card-answer .card-stamp");
  await page.waitFor("跳到回答里的时间点", `window.__seeked === 90`);
});

test("卡片：配好过、密钥随浏览器重启清空时，说明直说要到设置页重新填密钥、提一句记住密钥，「打开设置」是主按钮，不摆「生成概览」", async ({ open }) => {
  const page = await open(`${SAMPLE}#setup-key`);
  const shown = await page.evaluate(`(() => ({
    setup: document.getElementById("card-setup")?.textContent ?? "",
    settings: document.querySelector("#card-body > :first-child > #card-setup + #card-settings")?.getAttribute("data-variant") ?? null,
    generate: Boolean(document.getElementById("card-generate")),
  }))()`);
  assert.equal(shown.setup, "API 密钥随浏览器重启或扩展更新清空了，生成概览要先到设置页重新填；勾选「在这台电脑上记住密钥」就不用每次填。");
  assert.equal(shown.settings, "primary");
  assert.equal(shown.generate, false);
  const officialOnly = await open(`${SAMPLE}?setup=key#official-no-captions`);
  assert.equal(await officialOnly.evaluate(`Boolean(document.querySelector("#card-setup + #card-settings") && !document.querySelector("#card-generate, #card-official-verdict"))`), true);
});

test("卡片（YouTube）：有概览时结论在最前、只露前几章，没有官方总结那一行；没有代开文字稿的构建里本机还没有字幕时不摆「生成概览」，说先在侧边栏读、给「重试」；字幕读过就和 B 站一样摆「生成概览」", async ({ open }) => {
  const read = (page) =>
    page.evaluate(`(() => ({
      text: document.getElementById("card").innerText,
      status: document.getElementById("card-status")?.textContent ?? null,
      chapters: document.querySelectorAll("#card-overview .chapter").length,
      verdict: Boolean(document.querySelector("#card-overview .verdict")),
      official: Boolean(document.getElementById("card-official")),
      buttons: [...document.querySelectorAll("#card-generate, #card-status + #card-retry, #card-panel")].map((button) => button.id),
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
  assert.deepEqual(empty.buttons, ["card-panel", "card-retry"], "本机没有字幕（没有代开文字稿的构建）：卡片不去读，不摆「生成概览」");

  const ready = await open(`${SAMPLE}#youtube-ready`);
  assert.deepEqual((await read(ready)).buttons, ["card-panel", "card-generate"]);
});

test("卡片：五套主题的深浅两色下，生成按钮、官方总结文字链和更多操作的文字都读得清", async ({ open }) => {
  const page = await open(`${SAMPLE}#official`);
  const overview = await open(SAMPLE);
  await overview.setReducedMotion(true);
  await overview.click("#card-more-actions");
  for (const accentTheme of Object.keys(ACCENT_THEMES)) {
    for (const themeMode of ["light", "dark"]) {
      for (const [sample, selectors] of [
        [page, ["#card-generate", "#card-official-verdict"]],
        [overview, ["#card-panel", "#card-more-actions", "#card-regenerate", "#card-regenerate small", "#card-toggle-official", "#card-tools > button:last-child"]],
      ]) {
        await sample.setAppearance({ accentTheme, themeMode, uiFontScale: 100 });
        for (const [selector, contrast] of await sample.contrastAll(selectors)) {
          assert.ok(contrast >= 4.5, `${accentTheme} ${themeMode} ${selector} 对比度 ${contrast}`);
        }
      }
    }
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

test("卡片：官方总结一直读不到时，先说正在读，等够了照样摆出「生成概览」", async ({ open }) => {
  const page = await open(`${SAMPLE}#official-never`);
  await page.waitFor("说正在读官方总结", `document.getElementById("card")?.innerText.includes("正在读 B 站的官方总结")`);
  assert.equal(await page.evaluate(`Boolean(document.getElementById("card-generate"))`), false, "官方总结还在读，生成按钮先不摆");
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
        actions: document.getElementById("card-more-actions")?.getAttribute("aria-label"),
        panel: document.getElementById("card-panel")?.textContent,
        toggle: document.getElementById("card-toggle")?.title ?? "",
      }))()`);
    const page = await open(SAMPLE);
    await page.setWidth(FRAME_WIDTH, CARD_HEIGHT.max);
    assert.deepEqual(await read(page), {
      lang: "en",
      title: "Jianmu summary card",
      name: "Jianmu",
      more: "16 chapters",
      actions: "More actions",
      panel: "Side panel",
      toggle: "Collapse summary card",
    });
    const glance = await open(`${SAMPLE}#collapsed-glance`);
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict .verdict-name").textContent`), "Watch the key parts");
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict").getAttribute("aria-label")`), "3 out of 5 stars, Watch the key parts");
    assert.equal(await glance.evaluate(`document.getElementById("card-panel").textContent`), "Side panel");

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
      actions: "更多操作",
      panel: "侧边栏",
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
              panel: box("#card-panel"),
              more: box("#card-more-actions"),
              hit: [".card-verdict", ".card-collapse", "#card-panel", "#card-more-actions"].filter(s => document.querySelector(s)).every(s => { const node = document.querySelector(s); const r = node.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === node.closest("button"); }),
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
          assert.ok(at.chevron.right <= at.panel.left + 0.5 && at.panel.right <= at.card.right, label);
          if (hash) assert.equal(at.more, null, label);
          else assert.ok(at.panel.right <= at.more.left && at.more.right <= at.card.right, label);
          assert.ok(at.hit, `判断、箭头和头部入口都点得到 ${label}`);
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
        actions: document.getElementById("card-more-actions")?.getAttribute("aria-label"),
        panel: document.getElementById("card-panel")?.textContent,
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
      actions: "更多操作",
      panel: "側邊欄",
      toggle: "收合總結卡片",
    });
    assert.match(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`), /PingFang TC/);
    const glance = await open(`${SAMPLE}#collapsed-glance`);
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict .verdict-name").textContent`), verdictName(3, "zh-Hant"));
    assert.equal(await glance.evaluate(`document.querySelector(".card-verdict").getAttribute("aria-label")`), `5 星中的 3 星，${verdictName(3, "zh-Hant")}`);
    assert.deepEqual(simplifiedIn(await glance.evaluate(`document.getElementById("card-panel").textContent`)), []);

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
