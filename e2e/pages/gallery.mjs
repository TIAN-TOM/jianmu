// 共用组件的样张：章节和时间轨、判断标记、状态块、一行提示、模式切换、抽屉层菜单、首次启用说明，
// 以及两档宽度乘三套主题、两种明暗、三档字号下不出横向滚动条、关键文字对比度达标。
import assert from "node:assert/strict";
import { ACTIVATION_TABLE } from "../../src/core/consent.ts";
import { describe as describeError } from "../../src/core/errors.ts";
import { APPEARANCES, PANEL_WIDTHS, scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const GALLERY = "pages/gallery.html";

// 样张里的章节：时长 600 秒，四章从 0、120、300、540 秒开始，重点是第 2、4 章，播放到 210 秒。
const STARTS = ["0%", "20%", "50%", "90%"];

test("组件样张：有重点和没重点两种章节显示，时间轨和章节列表标的是同一几章", async ({ open }) => {
  const page = await open(GALLERY);
  const read = (id) =>
    page.call(
      `(id) => {
        const root = document.getElementById(id);
        return {
          heading: root.querySelector(".section-title").textContent,
          dots: [...root.querySelectorAll(".chapter .key-dot")].map((dot) => [dot.getAttribute("role"), dot.getAttribute("aria-label")]),
          keyRows: [...root.querySelectorAll(".chapter[data-key]")].map((row) => row.dataset.index),
          keyPieces: [...root.querySelectorAll(".rail-piece[data-key]")].map((piece) => piece.dataset.index),
          names: [...root.querySelectorAll(".chapter-name")].map((name) => name.textContent),
        };
      }`,
      id,
    );
  const withKeys = await read("rail-key");
  assert.equal(withKeys.heading, "章节 4，重点 2");
  assert.deepEqual(withKeys.dots, [
    ["img", "重点"],
    ["img", "重点"],
  ]);
  assert.deepEqual(withKeys.keyRows, ["1", "3"]);
  assert.deepEqual(withKeys.keyPieces, ["1", "3"], "时间轨上加粗的是同两章");
  const plain = await read("rail-plain");
  assert.equal(plain.heading, "章节 4");
  assert.deepEqual([plain.dots, plain.keyRows, plain.keyPieces], [[], [], []]);
  assert.deepEqual(plain.names, withKeys.names, "章节名原样，不因为是重点改写");
});

test("组件样张：章节的时间是单独的按钮，点了跳到这一章；章节名展开要点，读屏读得出展开状态", async ({ open }) => {
  const page = await open(GALLERY);
  const rows = await page.evaluate(
    `[...document.querySelectorAll("#rail-key .chapter")].map((row) => ({ time: row.querySelector(".chapter-time").getAttribute("aria-label"), expanded: row.querySelector(".chapter-toggle").getAttribute("aria-expanded") }))`,
  );
  assert.deepEqual(
    rows.map((row) => row.time),
    ["跳到 0:00", "跳到 2:00", "跳到 5:00", "跳到 9:00"],
  );
  assert.deepEqual(
    rows.map((row) => row.expanded),
    ["false", "true", "false", "false"],
  );
  await page.click("#rail-key .chapter[data-index='2'] .chapter-time");
  await page.waitFor("点时间跳转", `document.getElementById("seek-result").textContent === "300"`);
  await page.click("#rail-key .chapter[data-index='2'] .chapter-toggle");
  await page.waitFor("展开第 3 章", `document.querySelector("#rail-key .chapter[data-index='2'] .chapter-toggle").getAttribute("aria-expanded") === "true"`);
  const detail = await page.evaluate(`(() => { const toggle = document.querySelector("#rail-key .chapter[data-index='2'] .chapter-toggle"); return document.getElementById(toggle.getAttribute("aria-controls"))?.textContent ?? null; })()`);
  assert.match(detail, /这一章的要点/);
});

test("组件样张：时间轨竖着横着都按时长比例分段，播放头在播放位置，整条轨道不进读屏；生成中画分块进度、不画重点", async ({ open }) => {
  const page = await open(GALLERY, { width: 360 });
  const rails = await page.evaluate(`(() => {
    const read = (selector) => {
      const rail = document.querySelector(selector + " .rail");
      const box = rail.getBoundingClientRect();
      const pieces = [...rail.querySelectorAll(".rail-piece")];
      return {
        orientation: rail.dataset.orientation,
        hidden: rail.getAttribute("aria-hidden"),
        focusable: [...rail.querySelectorAll("button, [tabindex]")].length,
        starts: pieces.map((piece) => piece.style.getPropertyValue("--start")),
        kinds: pieces.map((piece) => piece.dataset.kind),
        keys: pieces.filter((piece) => piece.dataset.key).length,
        offsets: pieces.map((piece) => {
          const at = piece.getBoundingClientRect();
          return rail.dataset.orientation === "horizontal" ? (at.left - box.left) / box.width : (at.top - box.top) / box.height;
        }),
        head: rail.querySelector(".rail-head")?.style.getPropertyValue("--at") ?? null,
      };
    };
    return { vertical: read("#rail-key"), horizontal: read("#rail-horizontal"), blocks: read("#rail-blocks") };
  })()`);
  for (const name of ["vertical", "horizontal"]) {
    const rail = rails[name];
    assert.equal(rail.orientation, name);
    assert.equal(rail.hidden, "true", `${name}：不进读屏`);
    assert.equal(rail.focusable, 0, `${name}：不进 Tab 顺序`);
    assert.deepEqual(rail.starts, STARTS, `${name}：段的起点按时长比例`);
    assert.equal(rail.head, "35%", `${name}：播放头在 210 秒`);
    rail.offsets.forEach((offset, index) => assert.ok(Math.abs(offset - Number.parseFloat(STARTS[index] ?? "0") / 100) < 0.03, `${name}：第 ${index + 1} 段画在对应位置（${offset}）`));
  }
  assert.equal(rails.vertical.keys, 2);
  assert.deepEqual(rails.blocks.kinds, ["done", "writing", "failed", "pending"]);
  assert.equal(rails.blocks.keys, 0, "生成中不显示重点");
});

test("组件样张：五种判断标记形状各不相同，档位名用文字写出来，标记不进读屏；依据行、不完整和「基于旧字幕」标记", async ({ open }) => {
  const page = await open(GALLERY);
  const state = await page.evaluate(`(() => ({
    marks: [...document.querySelectorAll("#marks .verdict-mark")].map((mark) => ({ shape: mark.dataset.shape, hidden: mark.getAttribute("aria-hidden"), drawn: mark.children.length })),
    verdicts: [...document.querySelectorAll("#verdicts .verdict")].map((block) => ({
      label: block.getAttribute("aria-label"),
      shape: block.dataset.shape ?? null,
      markHidden: block.querySelector(".verdict-mark")?.getAttribute("aria-hidden") ?? null,
      name: block.querySelector(".verdict-name")?.textContent ?? null,
      text: block.querySelector(".verdict-text").textContent,
      basis: block.querySelector(".verdict-basis")?.textContent ?? null,
    })),
  }))()`);
  assert.equal(new Set(state.marks.map((mark) => mark.shape)).size, 5, "五种形状");
  assert.ok(state.marks.every((mark) => mark.hidden === "true" && mark.drawn > 0));
  assert.deepEqual(
    state.verdicts.map(({ shape, name }) => [shape, name]),
    [
      ["go", "值得看完整视频"],
      ["square", "看概览就够"],
      ["skip", "可以跳过"],
      ["unknown", "信息不足"],
      [null, null],
    ],
  );
  assert.ok(state.verdicts.every((verdict) => verdict.label === "一句话结论"));
  assert.ok(state.verdicts.slice(0, 4).every((verdict) => verdict.markHidden === "true"));
  assert.deepEqual(
    state.verdicts.map((verdict) => verdict.basis),
    ["依据字幕", "依据 B 站官方总结，没有通读字幕", "依据标题和简介基于旧字幕", "依据未知（旧版）不完整", null],
  );
  assert.equal(state.verdicts[4]?.text, "样例结论：档位认不出来时只写结论句。");
});

test("组件样张：三段式状态块写原因、影响和下一步，一个主按钮、最多两个次按钮", async ({ open }) => {
  const page = await open(GALLERY);
  const block = await page.evaluate(`(() => {
    const root = document.querySelector("#state-demo .state-block");
    const title = root.querySelector("h2");
    return {
      labelled: root.getAttribute("aria-labelledby") === title.id,
      title: title.textContent,
      impact: root.querySelector(".state-impact").textContent,
      buttons: [...root.querySelectorAll(".state-actions button")].map((button) => [button.dataset.variant, button.textContent]),
      notes: [...root.querySelectorAll(".control-note")].map((note) => note.textContent),
    };
  })()`);
  assert.equal(block.labelled, true);
  assert.equal(block.title, describeError("NO_CAPTIONS"));
  assert.equal(block.impact, "读不到字幕，生成不了完整概览。可以导入字幕文件。");
  assert.deepEqual(block.buttons, [
    ["primary", "导入字幕文件"],
    ["secondary", "只用标题和简介写结论"],
    ["secondary", "重新读取"],
  ]);
  assert.deepEqual(block.notes, ["会调用一次模型"]);
});

test("组件样张：一行提示一次只显示优先的那一条，礼貌播报，播报区一直在页面上", async ({ open }) => {
  const page = await open(GALLERY);
  const read = () =>
    page.evaluate(`(() => {
      const slot = document.querySelector("#notice-demo .notice-slot");
      const notices = [...slot.querySelectorAll(".notice")];
      return { live: slot.getAttribute("aria-live"), count: notices.length, id: notices[0]?.dataset.id, tone: notices[0]?.dataset.tone, text: notices[0]?.textContent, marked: slot.dataset.marked ?? null };
    })()`);
  assert.deepEqual(await read(), { live: "polite", count: 1, id: "consent", tone: "warn", text: "数据说明更新了，重新同意后才能用 AI 功能去看看", marked: null });
  // 给播报区做个记号，换内容以后记号还在，说明是同一个节点。
  await page.evaluate(`document.querySelector("#notice-demo .notice-slot").dataset.marked = "before"`);
  await page.click("#notice-drop-top");
  await page.waitFor("换成下一条", `document.querySelector("#notice-demo .notice")?.dataset.id === "remembered"`);
  const after = await read();
  assert.equal(after.count, 1);
  assert.equal(after.marked, "before", "播报区还是同一个节点，换内容读屏念得出来");
});

test("组件样张：模式切换是单选组，左右方向键切换，只有选中的那个在 Tab 顺序里", async ({ open }) => {
  const page = await open(GALLERY);
  const read = () =>
    page.evaluate(`(() => {
      const group = document.querySelector("#modes-demo [role='radiogroup']");
      return { label: group.getAttribute("aria-label"), radios: [...group.querySelectorAll("[role='radio']")].map((radio) => [radio.textContent, radio.getAttribute("aria-checked"), radio.tabIndex]), value: document.getElementById("mode-value").textContent };
    })()`);
  assert.deepEqual(await read(), { label: "模式", radios: [["速览", "true", 0], ["精读", "false", -1]], value: "skim" });
  await page.click("#modes-demo [role='radio'][aria-checked='true']");
  await page.press("ArrowRight");
  await page.waitFor("切到精读", `document.getElementById("mode-value").textContent === "study"`);
  assert.deepEqual((await read()).radios, [["速览", "false", -1], ["精读", "true", 0]]);
  assert.equal((await page.focused())?.text, "精读", "焦点跟着选中项走");
  await page.press("ArrowLeft");
  await page.waitFor("切回速览", `document.getElementById("mode-value").textContent === "skim"`);
});

// 无头 Chrome 里经调试协议发 Esc 键关模态对话框，扩展页面的渲染进程会卡住十几秒，测试不稳。
// 这里改用浏览器的关闭请求：Esc 和它走同一条路（先发可取消的 cancel，页面不拦就关），组件的处理一样被测到。
// 真实按 Esc 由开发者本人在实机上看。
const requestClose = (selector) => `document.querySelector(${JSON.stringify(selector)}).requestClose()`;

test("组件样张：抽屉和层收到关闭请求就关，焦点回到打开它的按钮；点遮罩也能关抽屉", async ({ open }) => {
  const page = await open(GALLERY);
  for (const [opener, selector] of [
    ["#open-sheet", "dialog.sheet"],
    ["#open-layer", "dialog.layer"],
  ]) {
    await page.click(opener);
    await page.waitFor(`${selector} 打开`, `document.querySelector(${JSON.stringify(selector)}).open`);
    const shown = await page.evaluate(`(() => { const dialog = document.querySelector(${JSON.stringify(selector)}); return { inside: dialog.contains(document.activeElement), title: document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent }; })()`);
    assert.equal(shown.inside, true, `${selector}：焦点进了浮层`);
    assert.ok(shown.title, `${selector}：有标题`);
    await page.evaluate(requestClose(selector), { userGesture: true });
    await page.waitFor(`${selector} 关上`, `!document.querySelector(${JSON.stringify(selector)}).open`);
    assert.equal((await page.focused())?.id, opener.slice(1), `${selector}：焦点回到打开它的按钮`);
    // 不经页面、浏览器直接关掉（连按 Esc 时可能这样）：页面的状态也要跟着改回来，下次还能打开。
    await page.click(opener);
    await page.waitFor(`${selector} 再打开`, `document.querySelector(${JSON.stringify(selector)}).open`);
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).close()`);
    await page.waitFor(`${selector} 再关上`, `!document.querySelector(${JSON.stringify(selector)}).open`);
    assert.equal((await page.focused())?.id, opener.slice(1), `${selector}：浏览器直接关的也把焦点还回去`);
    await page.click(opener);
    await page.waitFor(`${selector} 第三次打开`, `document.querySelector(${JSON.stringify(selector)}).open`);
    await page.evaluate(requestClose(selector), { userGesture: true });
    await page.waitFor(`${selector} 第三次关上`, `!document.querySelector(${JSON.stringify(selector)}).open`);
  }
  // 抽屉开着时整个组件被拿掉（比如换了视频）：焦点也回到打开它的按钮，不落到页面上。
  await page.click("#open-sheet");
  await page.waitFor("抽屉打开", `document.querySelector("dialog.sheet")?.open`);
  await page.evaluate("window.galleryControls.unmountSheet()");
  await page.waitFor("抽屉拿掉", `!document.querySelector("dialog.sheet")`);
  assert.equal((await page.focused())?.id, "open-sheet", "拿掉组件也把焦点还回去");
  await page.evaluate("window.galleryControls.mountSheet()");
  await page.click("#open-sheet");
  await page.waitFor("抽屉打开", `document.querySelector("dialog.sheet").open`);
  // 遮罩在抽屉上面那一截。
  await page.evaluate(`(() => { const box = document.querySelector("dialog.sheet").getBoundingClientRect(); window.__backdrop = { x: box.left + 10, y: Math.max(2, box.top - 20) }; return true; })()`);
  const at = await page.evaluate("window.__backdrop");
  await page.clickAt(at.x, at.y);
  await page.waitFor("点遮罩关上", `!document.querySelector("dialog.sheet").open`);
  assert.equal((await page.focused())?.id, "open-sheet");
});

test("组件样张：菜单上下键移动、到头绕回，收起或选了一项都把焦点还给按钮", async ({ open }) => {
  const page = await open(GALLERY);
  const trigger = "#menu-demo .menu-anchor > button";
  const isOpen = `document.querySelector("#menu-demo .menu").matches(":popover-open")`;
  await page.click(trigger);
  // 弹出层打开以后焦点才移进去，事件晚一拍到。
  await page.waitFor("焦点进了菜单", `document.activeElement?.getAttribute("role") === "menuitem"`);
  const menu = await page.evaluate(`(() => { const menu = document.querySelector("#menu-demo .menu"); const box = menu.getBoundingClientRect(); return { role: menu.getAttribute("role"), label: menu.getAttribute("aria-label"), expanded: document.querySelector(${JSON.stringify(trigger)}).getAttribute("aria-haspopup"), items: [...menu.querySelectorAll("[role='menuitem']")].length, inside: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight }; })()`);
  assert.deepEqual(menu, { role: "menu", label: "任务", expanded: "menu", items: 3, inside: true });
  await page.press("ArrowDown");
  assert.match((await page.focused())?.text ?? "", /^全部停止/);
  await page.press("ArrowUp");
  await page.press("ArrowUp");
  assert.equal((await page.focused())?.text, "暂时不能用", "从第一项往上绕到最后一项");
  await page.click("#menu-demo .menu [aria-disabled='true']");
  assert.equal(await page.evaluate(isOpen), true, "点停用的项不收起，也不执行");
  assert.equal(await page.evaluate(`document.getElementById("picked").textContent`), "");
  await page.evaluate(`document.querySelector("#menu-demo .menu").hidePopover()`);
  await page.waitFor("菜单收起", `!${isOpen}`);
  assert.equal((await page.focused())?.text, "任务", "焦点回到菜单按钮");

  await page.click(trigger);
  await page.waitFor("菜单再打开", `document.activeElement?.getAttribute("role") === "menuitem"`);
  await page.click("#menu-demo .menu [role='menuitem']");
  await page.waitFor("选了一项", `document.getElementById("picked").textContent === "停止这一项"`);
  assert.equal(await page.evaluate(isOpen), false);
  assert.equal((await page.focused())?.text, "任务");
});

test("组件样张：首次启用说明按三节列出完整说明；说明更新时只列新增、完整说明收起来；写入中停用、失败写原因", async ({ open }) => {
  const page = await open(GALLERY);
  const read = (id) =>
    page.call(
      `(id) => {
        const root = document.querySelector("#" + id + " .activation");
        const button = root.querySelector(".activation-foot button");
        return {
          title: root.querySelector("h2").textContent,
          headings: [...root.querySelectorAll(":scope > .activation-section h3")].map((h) => h.textContent),
          lines: [...root.querySelectorAll(":scope > .activation-section li")].map((li) => li.textContent),
          full: root.querySelector("details summary")?.textContent ?? null,
          button: [button.textContent, button.disabled],
          alert: root.querySelector("[role='alert']")?.textContent ?? null,
          footnote: root.querySelector(".activation-footnote").textContent,
          icon: root.querySelector("img.activation-icon").getAttribute("alt"),
        };
      }`,
      id,
    );
  const items = ACTIVATION_TABLE.flatMap((row) => row.items);
  const fresh = await read("activation-fresh");
  assert.equal(fresh.title, "先看看简幕会读什么");
  assert.deepEqual(fresh.headings, ["会读取什么", "用来做什么", "本机存什么"]);
  assert.deepEqual(fresh.lines.toSorted(), items.map((item) => item.text).toSorted());
  assert.deepEqual([fresh.full, fresh.button, fresh.alert, fresh.icon], [null, ["启用简幕", false], null, ""]);
  assert.equal(fresh.footnote, "启用只在本机读取和处理。发给模型服务要另外在设置页同意。");

  const updated = await read("activation-updated");
  assert.equal(updated.title, "简幕要多读一样东西");
  assert.deepEqual([updated.headings, updated.lines], [["会读取什么"], ["示例：说明新增的一项读取"]]);
  assert.deepEqual([updated.full, updated.button], ["查看完整说明", ["继续使用简幕", false]]);

  assert.deepEqual((await read("activation-saving")).button, ["正在启用", true]);
  const failed = await read("activation-failed");
  assert.deepEqual([failed.alert, failed.button], ["样例原因：设置没写进去，再点一次试试。", ["启用简幕", false]]);

  await page.click("#activation-fresh .activation-foot button");
  await page.waitFor("点了启用", `document.getElementById("activation-confirms").textContent === "1"`);
});

// 关键文字：结论句和档位、依据、章节时间和名字、提示行、状态块、标记、按钮、停用原因、启用说明。
const CONTRAST_TARGETS = [
  ".verdict-text",
  "#verdicts .verdict[data-shape='go'] .verdict-name",
  "#verdicts .verdict[data-shape='square'] .verdict-name",
  "#verdicts .verdict[data-shape='skip'] .verdict-name",
  "#verdicts .verdict[data-shape='unknown'] .verdict-name",
  "#verdicts .verdict-basis span",
  "#rail-key .section-title",
  "#rail-key .chapter-time",
  "#rail-key .chapter-name",
  "#rail-key .gallery-detail",
  "#notice-demo .notice-text",
  "#notice-demo .notice-action",
  "#state-demo .state-title",
  "#state-demo .state-impact",
  "#state-demo .button[data-variant='primary']",
  "#state-demo .control-note",
  "#controls .button[data-variant='danger']",
  "#controls .button[data-variant='text']",
  "#controls .control-reason",
  "#controls .badge[data-tone='warn']",
  "#controls .badge[data-tone='ok']",
  "#controls .badge[data-tone='line']",
  "#modes-demo [role='radio'][aria-checked='false']",
  "#activation-fresh .activation-heading",
  "#activation-fresh .activation-footnote",
  "#activation-failed .activation-error",
  "#activation-updated summary",
];

test("组件样张：320 和 360 宽、三套主题、两种明暗、三档字号下都不出横向滚动条，关键文字对比度达 AA", async ({ open }) => {
  const page = await open(GALLERY);
  const problems = [];
  for (const width of PANEL_WIDTHS) {
    await page.setWidth(width);
    for (const appearance of APPEARANCES) {
      await page.setAppearance(appearance);
      const label = `${width} 宽 ${appearance.accentTheme} ${appearance.themeMode} ${appearance.uiFontScale}%`;
      if (await page.overflowsX()) problems.push(`${label}：出现横向滚动条`);
      const ratios = await page.contrastAll(CONTRAST_TARGETS);
      for (const [selector, ratio] of ratios) if (ratio < 4.5) problems.push(`${label}：${selector} 对比度 ${ratio}`);
    }
  }
  assert.deepEqual(problems, []);
});
