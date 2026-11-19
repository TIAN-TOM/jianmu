// 解压覆盖新版以后简幕自己重新加载：后台醒来时发现扩展目录里的构建标识换了，就重新加载自己。
// - 覆盖之前：确认启用、存一条笔记，开着两个视频页，一个在前台、一个在后台，都挂着图标。
// - 覆盖之后：等过一分钟的节流，下一个事件叫醒后台时，它自己要重新加载，没有谁替它点刷新；
//   设置页正在恢复备份（导入的长连接开着）时先不重载，导入结束、连接断开以后才重载。
// - 重新加载以后：扩展还启用着，后台是新构建，启用确认和笔记都还在；两个视频页都补注入了新的内容脚本，旧的那份撤下。
//   前台那页的卡片不用刷新就摆出官方总结和按钮；后台那页的卡片照常等切到前台才读，切过去也摆全。之后不再要重载。
//
//   在 npm run test:e2e:lifecycle 里跟在生命周期冒烟后面跑，用的是同一个发行包，约一分半；用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
//
// 走的是浏览器真的重新加载。新建的资料目录默认关着开发者模式，从文件夹加载的扩展自己重新加载以后会被停用
// （停用原因 unsupportedDeveloperExtension），所以先在扩展管理页里打开它；用户从文件夹加载扩展时本来就开着。
// 「新版」是把这份发行包里的构建标识整个换成另一个：编进各个包的和标识文件里的一起换，和真的换了一版一样对得上。
// 第一个加载：装的是发行包，之后导入的产品模块按发行构建的开关取值算。
import "../scripts/lib/release-globals.mjs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { videoKey } from "../src/core/video-ref.ts";
import { BUSY_RECHECK_MS, CHECK_INTERVAL_MS } from "../src/background/self-update.ts";
import { BUILD_ID_FILE } from "../src/shared/build-id.ts";
import { DATABASE_NAME, INJECTED, PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../src/shared/names.ts";
import { launchChrome, prepareExtension } from "./browser.mjs";
import { VIDEOS } from "./fixtures.mjs";
import { PROBE, startMockServer, watchPage } from "./mock-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT_MS = 20_000;
const HARD_TIMEOUT_MS = 180_000;
// 重新加载以后看这么久，确认没有接着再重载。
const SETTLE_MS = 5000;
const NEW_BUILD = "0e2e0e2e0e2e0e2e";
const [VIDEO_ID = "", BACKGROUND_VIDEO_ID = ""] = Object.keys(VIDEOS);
const VIDEO = videoKey({ platform: "bilibili", videoId: VIDEO_ID });
// 登录了的样例视频都有官方总结；模型服务没配，卡片上的按钮是「打开设置」。
const CARD_LOADED = ["自造的样例总结", "打开设置"];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(label, read, timeoutMs = STEP_TIMEOUT_MS) {
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
    await sleep(200);
  }
}

/** 覆盖新版：目录里每个文本文件里的旧标识都换成新的，标识文件也换。 */
function overwriteWithNewBuild(dir, oldBuild) {
  let touched = 0;
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(js|html|css|json|txt)$/.test(name)) continue;
      const text = readFileSync(path, "utf8");
      if (!text.includes(oldBuild)) continue;
      writeFileSync(path, text.replaceAll(oldBuild, NEW_BUILD));
      touched += 1;
    }
  };
  walk(dir);
  return touched;
}

const executable = process.env.CHROME_PATH;
if (!executable) throw new Error("用 CHROME_PATH 指定 Chrome for Testing 的可执行文件");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "jianmu-self-reload-"));
const extensionDir = join(work, "extension");
prepareExtension({ zip: join(ROOT, "dist", `jianmu-${version}.zip`), dir: extensionDir });
const oldBuild = readFileSync(join(extensionDir, BUILD_ID_FILE), "utf8").trim();

const mock = await startMockServer({ dir: work });
const browser = launchChrome({ executable, profileDir: join(work, "profile"), hostRules: mock.hostRules, extensionDir });
const { cdp } = browser;
const hardStop = setTimeout(() => {
  console.error(`✗ 超过 ${HARD_TIMEOUT_MS / 1000} 秒仍未结束`);
  browser.child.kill("SIGKILL");
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardStop.unref();

const targets = new Map();
const destroyed = new Set();
cdp.on(({ method, params }) => {
  if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") targets.set(params.targetInfo.targetId, params.targetInfo);
  if (method === "Target.targetDestroyed") {
    targets.delete(params.targetId);
    destroyed.add(params.targetId);
  }
});

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

async function open(url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
}

/**
 * 开一个占标签页的扩展页面（默认侧边栏），用它给后台发消息。扩展刚重新加载完的一小会儿里，打开扩展页面会被浏览器拦下，
 * 拦下了就关掉重开。
 */
async function openPanel(extensionId, timeoutMs = STEP_TIMEOUT_MS, path = PAGE_PATHS.sidepanel) {
  return until("扩展页面的脚本就绪", async () => {
    const page = await open(`chrome-extension://${extensionId}/${path}`);
    try {
      await until("页面加载", () => evaluate(page.sessionId, `document.readyState === "complete"`), 5000);
      if (await evaluate(page.sessionId, `typeof chrome?.runtime?.sendMessage === "function"`)) return page;
    } catch {}
    await cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    return null;
  }, timeoutMs);
}

const ask = (page, type, req = {}) => evaluate(page.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);

const workers = (extensionId) =>
  [...targets.values()].filter((info) => info.type === "service_worker" && info.url === `chrome-extension://${extensionId}/background.js`);

const step = (label) => console.log(`✓ ${label}`);

/** 在扩展管理页里打开开发者模式。回这个页面，之后用它看扩展是不是还启用着。 */
async function developerMode() {
  const page = await open("chrome://extensions");
  await until("扩展管理页的接口就绪", () => evaluate(page.sessionId, `typeof chrome?.developerPrivate?.updateProfileConfiguration === "function"`));
  await evaluate(page.sessionId, `new Promise((done) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, done)).then(() => true)`);
  return page;
}

/** 扩展管理页上这个扩展的状态和停用原因。 */
const extensionState = (manager, extensionId) =>
  evaluate(
    manager.sessionId,
    `new Promise((done) => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, done)).then((list) => {
      const found = list.find((item) => item.id === ${JSON.stringify(extensionId)});
      return found ? JSON.stringify({ state: found.state, reasons: Object.keys(found.disableReasons).filter((key) => found.disableReasons[key]) }) : "没装";
    })`,
  );

/** 这个视频页里的卡片框架：卡片按所在标签页的地址认，skip 里的不算，接不上的跳过。 */
async function cardOf(videoId, extensionId, skip = new Set()) {
  const frames = [...targets.values()].filter((info) => info.type === "iframe" && info.url === `chrome-extension://${extensionId}/${PAGE_PATHS.card}` && !skip.has(info.targetId));
  for (const info of frames.reverse()) {
    try {
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
      const url = await evaluate(sessionId, `chrome.tabs.getCurrent().then((tab) => tab?.url ?? "")`);
      if (url === watchPage(videoId)) return { sessionId, targetId: info.targetId };
    } catch {}
  }
  return null;
}

const cardText = (card) => evaluate(card.sessionId, `document.getElementById("card")?.textContent ?? ""`);
const loaded = (text) => CARD_LOADED.every((part) => text.includes(part));

try {
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { id } = await browser.loadExtension();
  await until("后台起来", () => workers(id).length === 1);

  const login = await open(PROBE.login);
  await until("模拟登录页打开", () => evaluate(login.sessionId, `document.readyState === "complete"`));
  await cdp.send("Target.closeTarget", { targetId: login.targetId });

  const panel = await openPanel(id);
  const confirmed = await ask(panel, "activation.confirm");
  if (!confirmed?.ok) throw new Error(`确认启用失败：${JSON.stringify(confirmed)}`);
  const saved = await ask(panel, "notes.save", { video: VIDEO, atSec: 12, text: "更新前记的笔记" });
  if (!saved?.ok) throw new Error(`存笔记失败：${JSON.stringify(saved)}`);
  const before = await ask(panel, "build.id");
  if (before?.value?.build !== oldBuild) throw new Error(`后台的构建标识和包里的对不上：${JSON.stringify(before)}，包里是 ${oldBuild}`);
  step("覆盖之前：确认启用、存了一条笔记，后台是包里的那一版");

  const manager = await developerMode();
  step("扩展管理页里打开了开发者模式");

  // 两个视频页：后台那页先开，前台那页后开。图标和卡片在页面到过前台以后才挂，所以挂上一页再开下一页。
  const pages = [];
  for (const videoId of [BACKGROUND_VIDEO_ID, VIDEO_ID]) {
    const page = await open(watchPage(videoId));
    await until("视频页上挂上图标", () => evaluate(page.sessionId, `document.getElementById(${JSON.stringify(INJECTED.overlay)}) !== null`));
    // 给旧的图标浮层做个记号：补注入的新脚本挂的是新节点，没有这个记号。
    await evaluate(page.sessionId, `(document.getElementById(${JSON.stringify(INJECTED.overlay)}).dataset.e2eOld = "1", true)`);
    pages.push(page);
  }
  const [background, video] = pages;
  const oldCard = await until("前台那页的卡片读出官方总结", async () => {
    const card = await cardOf(VIDEO_ID, id);
    return card && loaded(await cardText(card)) ? card : null;
  });
  const oldCards = new Set([oldCard.targetId, (await until("后台那页的卡片框架", () => cardOf(BACKGROUND_VIDEO_ID, id))).targetId]);

  // 接上 worker，它就不会因为空闲停掉：测试里导入的长连接一分钟不发消息，真实的导入一直在发。
  const [worker] = workers(id);
  if (!worker) throw new Error("没有 worker");
  await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  // 扩展重新加载会关掉它自己的页面：侧边栏一关就是重新加载了。
  const reloaded = () => destroyed.has(panel.targetId);

  // 设置页开始恢复备份：导入的长连接连上、合并完一段，还开着（后面几段还没发）。覆盖之前就连上，后台看文件时它一定已经在了。
  const options = await openPanel(id, STEP_TIMEOUT_MS, PAGE_PATHS.options);
  const firstPart = await evaluate(
    options.sessionId,
    `(async () => {
      const port = chrome.runtime.connect({ name: "backup.import" });
      globalThis.e2eImport = port;
      const reply = new Promise((done) => port.onMessage.addListener(done));
      port.postMessage({ type: "part", seq: 0, kind: "notes", records: [] });
      return JSON.stringify(await reply);
    })()`,
  );
  if (JSON.parse(firstPart)?.type !== "merged") throw new Error(`恢复备份的第一段没合并：${firstPart}`);
  // 设置页开在了最前面：把前台那页切回来，重新加载时它在前台、另一页在后台。
  await cdp.send("Page.bringToFront", {}, video.sessionId);
  const shown = await Promise.all([video, background].map((page) => evaluate(page.sessionId, "document.visibilityState")));
  if (shown.join() !== "visible,hidden") throw new Error(`两个视频页不是一前一后：${shown.join()}`);

  const touched = overwriteWithNewBuild(extensionDir, oldBuild);
  if (touched < 3) throw new Error(`覆盖新版只换了 ${touched} 个文件，构建标识没写进包里`);
  // 后台一分钟最多看一次文件：等过这一分钟，下一个事件就会看。
  await sleep(CHECK_INTERVAL_MS + 1000);
  if (reloaded()) throw new Error("没有事件就重新加载了");
  await ask(panel, "build.id");
  // 后台这时看了文件，发现换了，但导入还开着：隔一会儿再看，先不重载。
  await sleep(SETTLE_MS);
  if (reloaded()) throw new Error("恢复备份还没完就重新加载了");
  step("覆盖之后：设置页正在恢复备份，后台先不重新加载");

  await evaluate(options.sessionId, `(globalThis.e2eImport.disconnect(), true)`);
  await until("导入结束以后，后台自己重新加载，扩展页面跟着关掉", reloaded, BUSY_RECHECK_MS + STEP_TIMEOUT_MS);
  step("导入结束、连接断开以后，后台自己重新加载，没有谁替它点刷新");

  const state = await until("扩展管理页上看得到扩展", () => extensionState(manager, id));
  if (state !== JSON.stringify({ state: "ENABLED", reasons: [] })) throw new Error(`重新加载以后扩展不是启用着：${state}`);
  step("重新加载以后扩展还启用着");

  /** 补注入的新脚本挂上了自己的图标和卡片，旧的那份整套撤下了：页面上只有一套。等不到时把页面上挂着的带进报错。 */
  const untilReplaced = (label, page) => {
    const mounted = () =>
      evaluate(
        page.sessionId,
        `JSON.stringify({ overlays: [...document.querySelectorAll("#${INJECTED.overlay}")].map((node) => node.dataset.e2eOld ? "旧" : "新"), cards: document.querySelectorAll("#${INJECTED.cardFrame}").length })`,
      );
    return until(label, async () => (await mounted()) === JSON.stringify({ overlays: ["新"], cards: 1 })).catch(async (error) => {
      throw new Error(`${error.message}；页面上是 ${await mounted().catch(() => "读不到")}`);
    });
  };
  /** 卡片上的字等到摆全；等不到时把卡片上的字带进报错。 */
  const untilLoaded = (label, card) =>
    until(label, async () => loaded(await cardText(card))).catch(async (error) => {
      throw new Error(`${error.message}；卡片上是「${await cardText(card).catch(() => "读不到")}」`);
    });

  await untilReplaced("前台那页补注入了新的内容脚本，旧的那份整套撤下", video);
  const card = await until("前台那页有了新的卡片框架", () => cardOf(VIDEO_ID, id, oldCards));
  const build = await evaluate(card.sessionId, `chrome.runtime.sendMessage({ type: "build.id", req: {} })`);
  if (build?.value?.build !== NEW_BUILD) throw new Error(`重新加载以后后台还不是新的一版：${JSON.stringify(build)}`);
  step("重新加载以后后台是新的一版");
  await untilLoaded("前台那页的卡片不用刷新就摆出官方总结和按钮", card);
  step("前台那页补注入了新的内容脚本，旧的那份整套撤下；卡片不用刷新就摆出了官方总结和按钮");

  // 后台那页：图标和卡片照常等切到前台才挂、才读。
  if ((await evaluate(background.sessionId, "document.visibilityState")) !== "hidden") throw new Error("后台那页不在后台，测不到切到前台的这一步");
  await cdp.send("Page.bringToFront", {}, background.sessionId);
  await untilReplaced("后台那页切到前台以后，换上了新的内容脚本，旧的那份整套撤下", background);
  const hiddenCard = await until("后台那页有了新的卡片框架", () => cardOf(BACKGROUND_VIDEO_ID, id, oldCards));
  await untilLoaded("后台那页切到前台以后，卡片摆出官方总结和按钮", hiddenCard);
  step("后台那页切到前台以后，也换上了新的内容脚本，卡片摆全了");

  // 资料直接在 worker 里读：启用确认在本机设置里，笔记在数据库里。
  const fresh = await until("新的 worker", () => workers(id).find((info) => info.targetId !== worker.targetId));
  const { sessionId: freshSession } = await cdp.send("Target.attachToTarget", { targetId: fresh.targetId, flatten: true });
  const kept = await evaluate(
    freshSession,
    `(async () => {
      const settings = (await chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}))[${JSON.stringify(SETTINGS_STORAGE_KEY)}];
      const db = await new Promise((done, fail) => { const request = indexedDB.open(${JSON.stringify(DATABASE_NAME)}); request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
      const notes = await new Promise((done, fail) => { const request = db.transaction("notes").objectStore("notes").getAll(); request.onsuccess = () => done(request.result); request.onerror = () => fail(request.error); });
      return JSON.stringify({ activated: Boolean(settings?.activationVersion), notes: notes.map((note) => note.text) });
    })()`,
  );
  if (kept !== JSON.stringify({ activated: true, notes: ["更新前记的笔记"] })) throw new Error(`重新加载以后资料不对：${kept}`);
  step("启用确认和笔记都还在");

  await sleep(SETTLE_MS);
  if (destroyed.has(fresh.targetId) || (await evaluate(card.sessionId, `chrome.runtime.sendMessage({ type: "build.id", req: {} })`))?.value?.build !== NEW_BUILD) throw new Error("重新加载以后又接着重载了");
  step(`之后 ${SETTLE_MS / 1000} 秒里没有再要重载`);
  console.log("✓ 解压覆盖以后自己重新加载：全部通过");
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  browser.child.kill("SIGKILL");
  await mock.close?.();
  rmSync(work, { recursive: true, force: true });
}
