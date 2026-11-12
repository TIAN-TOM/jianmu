// 端到端里播放页的几步：确认启用前内容脚本什么都不挂；确认后不刷新页面就挂上笔记按钮和卡片；
// 登录后卡片显示模拟的官方总结，点笔记按钮、按快捷键各存一条笔记，配好模型服务后在卡片里点「生成概览」出结果；
// 宽屏时卡片挪到弹幕列表下面；清掉本机设置让启用失效后，不用刷新就全部撤下。点击和按键都经调试协议发，是真实的用户操作，要穿过页面上那层透明层。
import { createSettingsStore } from "../src/platform/settings-store.ts";
import { INJECTED } from "../src/shared/names.ts";
import { WATCH_PAGE_AT_SEC } from "./watch-page.mjs";

/** 页面框架激活以后内容脚本还要稳一会儿再插节点；这里多等一截，确认前确实什么都没插。 */
const SETTLE_MS = 3000;

/** 用真实的设置读写算出存储里该有的样子：选好服务商、填好密钥、同意数据说明、确认启用。 */
async function storedSettings(service) {
  const area = (data) => ({
    async get(keys) {
      return Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(entries) {
      Object.assign(data, structuredClone(entries));
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete data[key];
    },
  });
  const local = {};
  const session = {};
  const locks = { exclusive: (_name, work) => Promise.resolve().then(work), shared: (_name, work) => Promise.resolve().then(work) };
  const store = createSettingsStore({ storage: { local: area(local), session: area(session) }, locks });
  await store.save({ presetId: service.presetId, aiApiKey: service.key, aiModel: service.model }, "");
  await store.setDataConsent(true);
  await store.confirmActivation();
  return { local, session };
}

/**
 * @param {{ cdp: any, until: (label: string, read: () => any) => Promise<any>, evaluate: (session: string, expression: string) => Promise<any>,
 *   findSession: (type: string, url: string) => string | null, url: string }} deps
 */
export function createWatchSteps({ cdp, until, evaluate, findSession, url }) {
  let page = "";
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const mounted = () => evaluate(page, `JSON.stringify({ injected: document.querySelectorAll('[id^="jianmu-"]').length, frames: document.querySelectorAll("iframe").length })`);
  const rectOf = (session, selector) =>
    evaluate(session, `(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return box && box.width > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null; })()`);

  async function click(x, y) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, page);
  }

  async function press(key, code, keyCode) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key, windowsVirtualKeyCode: keyCode }, page);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode }, page);
  }

  /** 卡片是嵌在网页里的扩展框架，单独附加上去读它的文字。 */
  async function cardSession() {
    const target = await until("卡片框架出现", async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.find((info) => info.type === "iframe" && info.url.includes("/pages/card.html"));
    });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    return sessionId;
  }

  async function clickInCard(card, selector) {
    const frame = await until("卡片框架有了尺寸", () => rectOf(page, `#${INJECTED.cardFrame}`));
    const box = await until(`卡片里的 ${selector}`, () => rectOf(card, selector));
    await click(frame.x + box.x + box.width / 2, frame.y + box.y + box.height / 2);
  }

  const cardText = (card) => evaluate(card, `document.getElementById("card")?.textContent ?? ""`);

  return {
    /** 确认启用前打开播放页：等页面激活、再稳一会儿，什么都没插。 */
    async beforeActivation() {
      await cdp.send("Target.createTarget", { url });
      page = await until("播放页打开", () => findSession("page", url));
      await cdp.send("Page.enable", {}, page);
      await cdp.send("Page.bringToFront", {}, page);
      await until("页面框架激活", () => evaluate(page, `document.readyState === "complete" && !document.querySelector("[data-server-rendered]")`));
      await sleep(SETTLE_MS);
      const found = JSON.parse(await mounted());
      if (found.injected !== 0 || found.frames !== 0) throw new Error(`确认启用前播放页上挂了东西：${JSON.stringify(found)}`);
    },

    /** 确认启用以后不用刷新页面，笔记按钮和卡片就挂上。 */
    async afterActivation() {
      await until("确认后挂上笔记按钮和卡片", async () => {
        const found = JSON.parse(await mounted());
        return found.injected >= 3 && found.frames === 1;
      });
    },

    /** 登录后：卡片显示官方总结，按钮和快捷键各存一条笔记。返回模型服务配好之前卡片的文字。 */
    async notesAndOfficial(ask, video) {
      await cdp.send("Page.reload", {}, page);
      await until("刷新后页面框架激活", () => evaluate(page, `document.readyState === "complete" && !document.querySelector("[data-server-rendered]")`));
      await cdp.send("Page.bringToFront", {}, page);
      const card = await cardSession();
      const text = await until("卡片显示官方总结", async () => {
        const value = await cardText(card);
        return value.includes("自造的样例总结") && value.includes("打开设置") ? value : null;
      });

      const button = await until("笔记按钮可见", () => rectOf(page, `#${INJECTED.noteButton}`));
      await click(button.x + button.width / 2, button.y + button.height / 2);
      await until("按钮存下一条笔记", async () => {
        const reply = await ask("notes.list", { video });
        return reply?.ok && reply.value.notes.some((note) => note.atSec === WATCH_PAGE_AT_SEC);
      });
      await evaluate(page, `(document.querySelector("video").currentTime = 100, true)`);
      await press("n", "KeyN", 78);
      await until("快捷键存下第二条笔记", async () => {
        const reply = await ask("notes.list", { video });
        return reply?.ok && reply.value.notes.some((note) => note.atSec === 100);
      });
      return { card, text };
    },

    /** 配好模型服务以后「打开设置」换回「生成概览」，点一下出概览。 */
    async generate(card, panel, service) {
      const { local, session } = await storedSettings(service);
      await evaluate(panel, `Promise.all([chrome.storage.local.set(${JSON.stringify(local)}), chrome.storage.session.set(${JSON.stringify(session)})]).then(() => true)`);
      await until("卡片上出现「生成概览」", async () => (await cardText(card)).includes("生成概览"));
      await clickInCard(card, "#card-generate");
      try {
        return await until("卡片显示生成的概览和结论", async () => {
          const value = await cardText(card);
          return value.includes("模拟服务写的一句话结论") && value.includes("模拟服务写的章节") ? value : null;
        });
      } catch (error) {
        throw new Error(`${error.message}；卡片上是：${await cardText(card).catch(() => "读不到")}`);
      }
    },

    /** 清掉本机设置（清除全部数据会这样）：启用失效，播放页上的按钮和卡片不用刷新就全部撤下。 */
    async afterClear(panel) {
      await evaluate(panel, "chrome.storage.local.clear().then(() => true)");
      await until("启用失效后播放页上什么都不剩", async () => {
        const found = JSON.parse(await mounted());
        return found.injected === 0 && found.frames === 0;
      });
    },

    /** 宽屏时弹幕列表被推到视频下面：卡片挪到它后面。 */
    async wideScreen() {
      await evaluate(page, `(document.querySelector(".bpx-player-container").dataset.screen = "wide", document.getElementById("danmukuBox").style.marginTop = "400px", true)`);
      await until("宽屏时卡片挪到弹幕列表后面", () => evaluate(page, `document.getElementById("danmukuBox").nextElementSibling?.id === ${JSON.stringify(INJECTED.cardFrame)}`));
    },
  };
}
