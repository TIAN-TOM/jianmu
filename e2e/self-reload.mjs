// 解压覆盖新版以后简幕自己重新加载：后台醒来时发现扩展目录里的构建标识换了，就重新加载自己。
// - 覆盖之前：确认启用、存一条笔记，视频页上挂着图标。
// - 覆盖之后：等过一分钟的节流，下一个事件叫醒后台时，它自己要重新加载，没有谁替它点刷新；
//   设置页正在恢复备份（导入的长连接开着）时先不重载，导入结束、连接断开以后才重载。
// - 重新加载以后：后台是新构建，启用确认和笔记都还在；已开的视频页补注入了新的内容脚本；之后不再要重载。
//
//   在 npm run test:e2e:lifecycle 里跟在生命周期冒烟后面跑，用的是同一个发行包，约一分半；用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
//
// 无头的测试 Chrome 里，扩展自己调 runtime.reload() 以后就回不来了，启动参数加载的也打不开页面；用户从文件夹加载的没有这个问题。
// 所以把后台的 runtime.reload 换成只记一笔的，看到它被调用，再用调试协议对同一个目录加载一次，代替浏览器的重新加载。
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
const [VIDEO_ID = ""] = Object.keys(VIDEOS);
const VIDEO = videoKey({ platform: "bilibili", videoId: VIDEO_ID });

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

  const video = await open(watchPage(VIDEO_ID));
  await until("视频页上挂上图标", () => evaluate(video.sessionId, `document.getElementById(${JSON.stringify(INJECTED.overlay)}) !== null`));
  // 给旧的图标浮层做个记号：补注入的新脚本挂的是新节点，没有这个记号。
  await evaluate(video.sessionId, `(document.getElementById(${JSON.stringify(INJECTED.overlay)}).dataset.e2eOld = "1", true)`);

  // 测试 Chrome 里扩展调 runtime.reload() 以后就回不来了（用户从文件夹加载的会回来）：把它换成只记一笔的，
  // 看到后台自己要重新加载以后，用同一个目录再加载一次，这是浏览器重新加载扩展时做的事。
  const [worker] = workers(id);
  if (!worker) throw new Error("没有 worker");
  const { sessionId: workerSession } = await cdp.send("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  await evaluate(workerSession, `(chrome.runtime.reload = () => void (globalThis.e2eReloadAt = Date.now()), true)`);

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

  const touched = overwriteWithNewBuild(extensionDir, oldBuild);
  if (touched < 3) throw new Error(`覆盖新版只换了 ${touched} 个文件，构建标识没写进包里`);
  // 后台一分钟最多看一次文件：等过这一分钟，下一个事件就会看。
  await sleep(CHECK_INTERVAL_MS + 1000);
  if (await evaluate(workerSession, `globalThis.e2eReloadAt ?? null`)) throw new Error("没有事件就重新加载了");
  await ask(panel, "build.id");
  // 后台这时看了文件，发现换了，但导入还开着：隔一会儿再看，先不重载。
  await sleep(SETTLE_MS);
  if (await evaluate(workerSession, `globalThis.e2eReloadAt ?? null`)) throw new Error("恢复备份还没完就重新加载了");
  step("覆盖之后：设置页正在恢复备份，后台先不重新加载");

  await evaluate(options.sessionId, `(globalThis.e2eImport.disconnect(), true)`);
  await until("导入结束以后，后台自己要重新加载", () => evaluate(workerSession, `globalThis.e2eReloadAt ?? null`), BUSY_RECHECK_MS + STEP_TIMEOUT_MS);
  step("导入结束、连接断开以后，后台自己要重新加载，没有谁替它点刷新");

  const again = await browser.loadExtension();
  if (again.id !== id) throw new Error(`再加载以后扩展 ID 变了：${again.id}`);
  await until("扩展重新加载，扩展页面跟着关掉", () => destroyed.has(panel.targetId));

  await until(
    "已开的视频页补注入了新的内容脚本",
    // 只看新的浮层挂上了：调试协议的重新加载不切断旧脚本和扩展的联系，旧的那份在这里不会自己撤下（用户那边会，内容脚本的单元测试守着）。
    () => evaluate(video.sessionId, `[...document.querySelectorAll("#${INJECTED.overlay}")].some((node) => node.dataset.e2eOld === undefined)`),
  );
  step("已开的视频页补注入了新的内容脚本");

  // 测试 Chrome 里扩展重新加载以后，新开的扩展页面会被拦下，改从视频页里新插的卡片问后台的构建标识。
  const card = await until("视频页里有了新的卡片框架", async () => {
    const frames = [...targets.values()].filter((info) => info.type === "iframe" && info.url === `chrome-extension://${id}/${PAGE_PATHS.card}`);
    for (const info of frames.reverse()) {
      try {
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
        const reply = await evaluate(sessionId, `chrome.runtime.sendMessage({ type: "build.id", req: {} })`);
        if (reply?.ok) return { sessionId, build: reply.value.build };
      } catch {}
    }
    return null;
  });
  if (card.build !== NEW_BUILD) throw new Error(`重新加载以后后台还不是新的一版：${card.build}`);
  step("重新加载以后后台是新的一版");

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
  if (destroyed.has(fresh.targetId) || (await evaluate(freshSession, `globalThis.e2eReloadAt ?? null`)) || (await evaluate(card.sessionId, `chrome.runtime.sendMessage({ type: "build.id", req: {} })`))?.value?.build !== NEW_BUILD) throw new Error("重新加载以后又接着重载了");
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
