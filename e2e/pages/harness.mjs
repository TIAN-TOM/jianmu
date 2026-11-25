// 页面测试的公共部分：场景文件用 scenario() 登记测试，入口按文件跑；每个测试拿到一个上下文，
// 能打开扩展页面、切宽度和外观、真实点击和按键、在页面里求值、取色算对比度、带手势打开侧边栏。
// 只断言 DOM 文字和属性，不截图比像素。
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_PATHS } from "../../src/shared/names.ts";
import { ACCENT_THEMES, UI_FONT_SCALES } from "../../src/shared/settings-schema.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const STEP_TIMEOUT_MS = 10_000;

/** @typedef {ReturnType<ReturnType<typeof createHarness>["context"]>} TestContext */
/**
 * timeoutMs 不给时用页面测试的默认时限。expectedErrors 是这个测试故意引出的扩展页面报错（比如后台记下的生成失败），
 * 按文字匹配放行，别的报错照样算失败。
 * @typedef {{ file: string, title: string, fn: (ctx: TestContext) => Promise<void>, timeoutMs?: number, expectedErrors?: readonly RegExp[] }} RegisteredTest
 */

/** @type {RegisteredTest[]} */
const registry = [];

/** 场景文件开头调一次：const test = scenario(import.meta.url)。报告里按文件记每个测试。 */
export function scenario(fileUrl) {
  const file = relative(ROOT, fileURLToPath(fileUrl)).split(sep).join("/");
  return (/** @type {string} */ title, /** @type {RegisteredTest["fn"]} */ fn, /** @type {{ timeoutMs?: number, expectedErrors?: readonly RegExp[] }} */ options = {}) => {
    if (registry.some((entry) => entry.title === title)) throw new Error(`页面测试标题重复：${title}`);
    registry.push({ file, title, fn, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}), ...(options.expectedErrors ? { expectedErrors: options.expectedErrors } : {}) });
  };
}

export const registered = () => [...registry];

/** 三套主题、两种明暗、三档字号，取值和设置模块一致。 */
export const APPEARANCES = Object.keys(ACCENT_THEMES).flatMap((accentTheme) =>
  ["light", "dark"].flatMap((themeMode) => UI_FONT_SCALES.map((uiFontScale) => ({ accentTheme, themeMode, uiFontScale }))),
);
export const PANEL_WIDTHS = [320, 360];

const sleep = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms));

/** 条件成立就返回它的值，到点还不成立就报错；读的时候出错也接着等。 */
export async function until(label, read, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`等不到：${label}${lastError ? `（${lastError.message}）` : ""}`);
    await sleep(25);
  }
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13 },
  " ": { code: "Space", keyCode: 32 },
  Tab: { code: "Tab", keyCode: 9 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
};

// 在页面里跑的取色：画到 1×1 的画布上读回像素，CSS 写成什么颜色格式都能比；背景从外往里一层层叠。
const CONTRAST_SCRIPT = `(selector) => {
  const node = document.querySelector(selector);
  if (!node) throw new Error("找不到 " + selector);
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgb(0 0 0 / 0)";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const over = (top, base) => {
    const a = top[3] + base[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + base[i] * base[3] * (1 - top[3])) / a).concat(a);
  };
  const chain = [];
  for (let at = node; at; at = at.parentElement) chain.unshift(at);
  let base = [255, 255, 255, 1];
  for (const at of chain) base = over(rgba(getComputedStyle(at).backgroundColor), base);
  const text = over(rgba(getComputedStyle(node).color), base);
  const lum = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(text), lum(base)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}`;

/**
 * @param {{ cdp: { send: (method: string, params?: object, sessionId?: string, timeoutMs?: number) => Promise<any> },
 *           extensionId: string, extensionDir: string, sessions: Map<string, { type: string, url: string, targetId: string }>,
 *           requests: readonly { kind?: string, at: number }[] }} deps
 */
export function createHarness({ cdp, extensionId, extensionDir, sessions, requests }) {
  const findSession = (/** @type {(info: { type: string, url: string }) => boolean} */ match) => {
    for (const [sessionId, info] of sessions) if (match(info)) return sessionId;
    return null;
  };

  async function evaluate(sessionId, expression, { userGesture = false } = {}) {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
    if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  }

  function pageHandle(sessionId, targetId) {
    const page = {
      sessionId,
      targetId,
      /** 在页面里求值，表达式的结果要能转成 JSON。 */
      evaluate: (expression, options) => evaluate(sessionId, expression, options),
      /** 调用一个写成字符串的函数，参数按 JSON 传进去。 */
      call: (fnSource, ...args) => evaluate(sessionId, `(${fnSource})(...${JSON.stringify(args)})`),
      waitFor: (label, expression, timeoutMs) => until(label, () => evaluate(sessionId, expression), timeoutMs),
      /**
       * 重新加载页面，等到确实换成新页面再往下：location.reload() 一返回，旧页面还在，紧接着的等待会先在旧页面上成立，
       * 再去点的时候新页面还没画出来。旧页面上留个记号，记号没了才算新页面。
       */
      async reload() {
        await evaluate(sessionId, "(window.__jianmuOldPage = true, location.reload(), true)");
        await until("页面重新加载", () => evaluate(sessionId, `!window.__jianmuOldPage && document.readyState !== "loading"`));
      },
      /** 系统设了减少动态效果；传 false 回到没设。 */
      async setReducedMotion(on) {
        await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "" }] }, sessionId);
      },
      async setWidth(width, height = 800) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      },
      /** 和页面脚本落外观时写的一样：主题、解析后的明暗写在 html 的 data 属性上，字号写根字号。 */
      async setAppearance({ accentTheme, themeMode, uiFontScale }) {
        await evaluate(
          sessionId,
          `(() => { const root = document.documentElement; root.dataset.accentTheme = ${JSON.stringify(accentTheme)}; root.dataset.themeMode = ${JSON.stringify(themeMode)}; root.style.setProperty("--ui-font-zoom", ${JSON.stringify(String(uiFontScale / 100))}); getComputedStyle(root).color; return true; })()`,
        );
        // 颜色有过渡，等过渡走完再取色。一直在转的动画（加载灰条）不算。
        await evaluate(sessionId, `Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => {}))).then(() => true)`);
      },
      /** 页面有没有横向滚动条。 */
      overflowsX: () => evaluate(sessionId, "document.documentElement.scrollWidth > document.documentElement.clientWidth"),
      /** 选中元素的文字和它实际的背景之间的对比度。 */
      contrastOf: (selector) => page.call(CONTRAST_SCRIPT, selector),
      /** 一次量一组元素，回 [选择器, 对比度] 的列表。 */
      contrastAll: (selectors) =>
        evaluate(sessionId, `((measure, selectors) => selectors.map((selector) => [selector, measure(selector)]))(${CONTRAST_SCRIPT}, ${JSON.stringify(selectors)})`),
      /** 真实的鼠标点击，落在元素中间；带用户激活。 */
      async click(selector) {
        const box = await page.call(
          `(selector) => { const node = document.querySelector(selector); if (!node) throw new Error("找不到 " + selector); node.scrollIntoView({ block: "center" }); const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }`,
          selector,
        );
        await page.clickAt(box.x, box.y);
      },
      /** 鼠标移到视口坐标上，不点。 */
      async moveTo(x, y) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, sessionId);
      },
      /** 在视口坐标上点一下。 */
      async clickAt(x, y) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" }, sessionId);
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, sessionId);
        }
      },
      /** 真实的按键，发给当前有焦点的元素。不登记 Esc：无头 Chrome 里经调试协议发 Esc 关模态对话框会卡住渲染进程。 */
      async press(key) {
        const info = KEYS[key];
        if (!info) throw new Error(`没登记的键：${key}`);
        const common = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
        await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common }, sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
      },
      /** 按回车并带上字符事件，跟真的按键一样：有焦点的输入框靠它提交所在的表单。 */
      async pressEnter() {
        const common = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...common }, sessionId);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
      },
      /** 把一段字输进有焦点的输入框，跟输入法上屏一样触发输入事件。 */
      async insertText(text) {
        await cdp.send("Input.insertText", { text }, sessionId);
      },
      /** 当前有焦点的元素，用一个选择器能认出来的描述：id、类名或文字。 */
      focused: () =>
        evaluate(
          sessionId,
          `(() => { const node = document.activeElement; if (!node || node === document.body) return null; return { id: node.id, role: node.getAttribute("role"), text: node.textContent.trim(), label: node.getAttribute("aria-label") }; })()`,
        ),
    };
    return page;
  }

  /** 每个测试一个上下文：打开的页面在测试结束时都关掉。 */
  function context() {
    const opened = [];

    // 按目标认会话：同一个地址前一个测试可能也开过。刚建的目标先停在空白页上等调试器，要等到真正的页面加载完。
    async function attach(url, targetId) {
      const sessionId = await until(`${url} 接上调试`, () => findSession((info) => info.targetId === targetId));
      const page = pageHandle(sessionId, targetId);
      await page.waitFor(`${url} 加载完`, `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
      return page;
    }

    /** 打开扩展里的一个页面（相对扩展根目录），默认按侧边栏的窄宽度。 */
    async function open(path, { width = PANEL_WIDTHS[0] } = {}) {
      const url = `chrome-extension://${extensionId}/${path}`;
      const { targetId } = await cdp.send("Target.createTarget", { url });
      opened.push(targetId);
      const page = await attach(url, targetId);
      await page.setWidth(width);
      return page;
    }

    /** 打开一个网页（站点请求都到本机模拟服务器），按桌面宽度；新开的标签页在前台。 */
    async function openPage(url, { width = 1280 } = {}) {
      const { targetId } = await cdp.send("Target.createTarget", { url });
      opened.push(targetId);
      const page = await attach(url, targetId);
      await page.setWidth(width);
      return page;
    }

    /** 在一个扩展页面里带用户手势打开真实的侧边栏，按地址接上它。 */
    async function openSidePanel(from) {
      await from.evaluate("chrome.tabs.getCurrent().then((tab) => chrome.sidePanel.open({ windowId: tab.windowId })).then(() => true)", { userGesture: true });
      const url = `chrome-extension://${extensionId}/${PAGE_PATHS.sidepanel}`;
      const sessionId = await until("侧边栏打开", () => findSession((info) => info.url === url && (info.type === "page" || info.type === "other")));
      const targetId = sessions.get(sessionId)?.targetId;
      if (targetId) opened.push(targetId);
      const page = pageHandle(sessionId, targetId);
      await page.waitFor("侧边栏加载完", `location.href === ${JSON.stringify(url)} && document.readyState === "complete"`);
      return page;
    }

    async function close() {
      for (const targetId of opened.splice(0)) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    }

    // 装上的扩展在磁盘上的目录：改这里的页面文件、不重新加载扩展，就是「旧后台、新页面」。
    // requests 是模拟服务器收到的全部请求，模型请求带 kind（问答是 "qa"）。
    return { open, openPage, openSidePanel, close, extensionId, extensionDir, requests };
  }

  return { context };
}
