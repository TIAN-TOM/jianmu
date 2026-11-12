// 端到端冒烟：把 zip 解压出来的扩展装进 Chrome for Testing，站点请求都到本机模拟服务器，其余域名解析失败。
// 核对后台和侧边栏都没有报错，主机权限和登录状态都生效，后台取字幕在确认前、没登录、付费时都按规矩停下，也没有意外请求。
// 播放页之后在真实的侧边栏里走一遍主流程：跟着视频页读字幕、点一句跳过去、生成概览、把金句存为笔记、提问并点引用跳转；
// 再从设置页打开粗筛页，读稍后再看、两步批次、分组和导出。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { videoKey } from "../src/core/video-ref.ts";
import { launchChrome, prepareExtension } from "./browser.mjs";
import { ANTHROPIC, VIDEOS } from "./fixtures.mjs";
import { apiHost, contentRead, fileHost, PROBE, startMockServer, watchPage } from "./mock-server.mjs";
import { storedSettings } from "./settings.mjs";
import { triageFlow } from "./triage-steps.mjs";
import { createWatchSteps } from "./watch-steps.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20_000;
const [FIRST_ID = "", SECOND_ID = ""] = Object.keys(VIDEOS);
const FIRST = videoKey({ platform: "bilibili", videoId: FIRST_ID });
const SECOND = videoKey({ platform: "bilibili", videoId: SECOND_ID });

// 调试器接上 service worker 时脚本可能还没跑，求值报错也接着等，超时才算失败。
async function until(label, read) {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = null;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`等不到：${label}${lastError ? `（${lastError.message}）` : ""}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}

const executable = process.env.CHROME_PATH;
if (!executable) throw new Error("用 CHROME_PATH 指定 Chrome for Testing 的可执行文件");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const expectedId = readFileSync(join(ROOT, "tests/fixtures/extension-id.txt"), "utf8").trim();
const work = mkdtempSync(join(tmpdir(), "jianmu-e2e-"));
const extensionDir = join(work, "extension");
// 模型服务的主机权限要用户在设置页点了才申请，无头 Chrome 里点不了，只给这份副本的清单加上。
prepareExtension({ zip: join(ROOT, "dist", `jianmu-${version}.zip`), dir: extensionDir, origins: [ANTHROPIC.origin] });

const mock = await startMockServer({ dir: work });
const browser = launchChrome({ executable, profileDir: join(work, "profile"), hostRules: mock.hostRules, extensionDir });
const { cdp } = browser;
const sessions = new Map();
const errors = [];

cdp.on(({ method, params, sessionId }) => {
  if (method === "Target.attachedToTarget") {
    sessions.set(params.sessionId, params.targetInfo);
    for (const domain of ["Runtime.enable", "Log.enable"]) cdp.send(domain, {}, params.sessionId).catch(() => {});
    cdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
    return;
  }
  // 刚建的目标先停在空白页上，导航以后才是真正的地址。
  if (method === "Target.targetInfoChanged") {
    for (const [id, info] of sessions) if (info.targetId === params.targetInfo.targetId) sessions.set(id, params.targetInfo);
    return;
  }
  const origin = sessions.get(sessionId)?.url ?? "";
  if (!origin.startsWith("chrome-extension://")) return;
  if (method === "Runtime.exceptionThrown") errors.push(`${origin}：${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
  if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push(`${origin}：${params.args.map((arg) => arg.value ?? arg.description).join(" ")}`);
  if (method === "Log.entryAdded" && params.entry.level === "error") errors.push(`${origin}：${params.entry.text}`);
});

function findSession(type, url) {
  for (const [sessionId, info] of sessions) {
    if (info.type === type && info.url === url) return sessionId;
  }
  return null;
}

async function evaluate(sessionId, expression, userGesture = false) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

/** 侧边栏页面里点一个元素：按选择器找，可以再按文字筛。 */
const clickIn = (session, selector, text = "") =>
  evaluate(
    session,
    `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.includes(${JSON.stringify(text)}) && !item.disabled); if (!node) return false; node.click(); return true; })()`,
  );

const textOf = (session, selector) => evaluate(session, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent).join("\\n")`);

/** 在真实的侧边栏里走主流程。启动用的扩展页面带着用户手势打开侧边栏，再在同一个窗口里打开视频页。 */
async function panelFlow(launcher, panelUrl, videoId) {
  const stored = await storedSettings(ANTHROPIC);
  await evaluate(launcher, `Promise.all([chrome.storage.local.set(${JSON.stringify(stored.local)}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
  const windowId = await evaluate(launcher, "chrome.tabs.getCurrent().then((tab) => chrome.sidePanel.open({ windowId: tab.windowId }).then(() => tab.windowId))", true);
  const panel = await until("侧边栏打开", () => {
    for (const [sessionId, info] of sessions) if (info.url === panelUrl && sessionId !== launcher && (info.type === "page" || info.type === "other")) return sessionId;
    return null;
  });
  const watchUrl = watchPage(videoId);
  await evaluate(launcher, `chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(watchUrl)} }).then(() => true)`);
  const video = await until("视频页打开", () => findSession("page", watchUrl));

  // 两个样例视频共用一份字幕：要认准标题，免得在切过来之前就把上一个视频页的字幕当成这一个的。
  const title = VIDEOS[videoId]?.title ?? "";
  await until("侧边栏跟着视频页读到字幕", async () => (await textOf(panel, ".video-title")) === title && (await textOf(panel, ".cue-text")).includes("样例台词二"));
  await until("视频页连上", () => evaluate(panel, `!document.querySelector(".notice[data-id='connect']")`));
  // 点最后一句的时间，视频页跳到的秒数要和按钮上写的对得上。先把播放位置挪开，看得出跳没跳。
  await evaluate(video, `(document.querySelector("video").currentTime = 100, true)`);
  const label = await until("点最后一句", () => evaluate(panel, `(() => { const times = document.querySelectorAll(".cue-time"); const last = times[times.length - 1]; if (!last) return null; last.click(); return last.textContent; })()`));
  const seeked = await until("视频页跳到那一句", async () => {
    const at = await evaluate(video, `document.querySelector("video")?.currentTime ?? 100`);
    return at !== 100 ? String(at) : null;
  });
  const seconds = Math.floor(Number(seeked));
  if (`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` !== label) throw new Error(`点的是 ${label}，视频页跳到了 ${seeked} 秒`);
  console.log("✓ 侧边栏跟着视频页读到字幕，点一句跳到了那里");

  await until("切到概览页签", () => clickIn(panel, "#tab-overview"));
  await until("生成概览可以点", () => clickIn(panel, "button", "生成概览"));
  await until("概览生成完", async () => (await textOf(panel, ".chapter-name")).includes("模拟服务写的章节"));
  await until("结论写好", async () => (await textOf(panel, ".verdict-text")).includes("模拟服务写的一句话结论"));
  console.log("✓ 生成概览：章节和一句话结论都显示出来");

  await until("展开章节", () => clickIn(panel, ".chapter-toggle"));
  await until("把金句存为笔记", () => clickIn(panel, ".quote button", "存为笔记"));
  await until("存好笔记", async () => (await textOf(panel, ".notice-text")).includes("已存为笔记"));
  await until("切到笔记页签", () => clickIn(panel, "#tab-notes"));
  await until("笔记页签列出这条", async () => (await textOf(panel, ".note-text")).includes("模拟服务挑的金句"));
  console.log("✓ 金句存成笔记，笔记页签列出来");

  await until("切到问答页签", () => clickIn(panel, "#tab-qa"));
  await until("提问框可以用", () =>
    evaluate(panel, `(() => { const input = document.querySelector(".qa-form input"); if (!input) return false; input.value = "这个视频讲了什么"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`),
  );
  await until("提问", () => clickIn(panel, ".qa-form button", "提问"));
  await until("回答回来", async () => (await textOf(panel, ".qa-answer")).includes("模拟服务的回答"));
  await evaluate(video, `(document.querySelector("video").currentTime = 100, true)`);
  await until("点回答里的引用", () => clickIn(panel, ".qa-answer .stamp"));
  await until("视频页跳到引用的时间点", async () => (await evaluate(video, `document.querySelector("video")?.currentTime`)) === 0);
  console.log("✓ 问答：回答带引用，点引用跳到视频里的时间点");
}

let failed = false;
try {
  const { product } = await cdp.send("Browser.getVersion", {}, undefined, TIMEOUT_MS);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  // 粗筛页导出 Markdown 会下载文件：落到临时目录。
  const downloads = join(work, "downloads");
  mkdirSync(downloads, { recursive: true });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  const { id } = await browser.loadExtension(TIMEOUT_MS);
  // 清单里的 key 固定了扩展 ID，换文件夹加载也不变。
  if (id !== expectedId) throw new Error(`扩展 ID 是 ${id}，应为 ${expectedId}`);
  console.log(`✓ ${product} 装上了扩展 ${id}`);

  const worker = await until("service worker 启动", () => findSession("service_worker", `chrome-extension://${id}/background.js`));
  await until("工具栏图标打开侧边栏的设置生效", () =>
    evaluate(worker, "chrome.sidePanel.getPanelBehavior().then((behavior) => behavior.openPanelOnActionClick)"),
  );
  const manifestVersion = await evaluate(worker, "chrome.runtime.getManifest().version");
  if (manifestVersion !== version) throw new Error(`清单版本是 ${manifestVersion}，应为 ${version}`);
  console.log("✓ service worker 启动");

  const pageUrl = `chrome-extension://${id}/pages/sidepanel.html`;
  await cdp.send("Target.createTarget", { url: pageUrl });
  const page = await until("侧边栏页面打开", () => findSession("page", pageUrl));
  const text = await until("侧边栏渲染出内容", () => evaluate(page, 'document.getElementById("app")?.textContent ?? ""'));
  console.log(`✓ 侧边栏显示：${text}`);

  // 从侧边栏页面给后台发消息：自己占一个标签页时按路径算侧边栏。
  const ask = (type, req = {}) => evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);
  const status = await ask("activation.get");
  if (!status?.ok || status.value.state !== "needed") throw new Error(`装好以后应该还没确认启用：${JSON.stringify(status)}`);
  const beforeConfirm = mock.requests.length;
  const refused = await ask("transcript.get", { video: FIRST, mode: "full" });
  if (refused?.code !== "NOT_ENABLED") throw new Error(`确认前取字幕应该回还没启用：${JSON.stringify(refused)}`);
  if (mock.requests.length !== beforeConfirm) throw new Error("确认前取字幕发了请求");
  console.log("✓ 确认启用之前取字幕回还没启用，一个请求都没发");

  const watch = createWatchSteps({ cdp, until, evaluate, findSession, url: `https://${PROBE.pageHost}/video/${FIRST_ID}` });
  await watch.beforeActivation();
  if (mock.requests.some(contentRead)) throw new Error("确认启用前打开播放页就读了视频内容");
  console.log("✓ 确认启用前打开播放页：内容脚本什么都没挂，也没读视频内容");

  const confirmed = await ask("activation.confirm");
  if (!confirmed?.ok || confirmed.value.state !== "current") throw new Error(`确认启用失败：${JSON.stringify(confirmed)}`);
  const loggedOut = await ask("transcript.get", { video: FIRST, mode: "full" });
  if (loggedOut?.code !== "NEED_LOGIN") throw new Error(`没登录时取字幕应该回要登录：${JSON.stringify(loggedOut)}`);
  const peeked = mock.requests.filter(contentRead);
  if (peeked.length > 0) throw new Error(`没登录时读了视频内容：${JSON.stringify(peeked)}`);
  console.log("✓ 确认以后、没登录时取字幕只报要登录，没读任何视频内容");
  await watch.afterActivation();
  console.log("✓ 确认启用以后不刷新页面，播放页挂上了笔记按钮和卡片");

  const readLogin = () =>
    evaluate(worker, `fetch(${JSON.stringify(PROBE.account)}, { credentials: "include", cache: "no-store" }).then((response) => response.json()).then(${PROBE.loginOf})`);
  if ((await readLogin()) !== false) throw new Error("没登录时账号接口就回了已登录");
  await cdp.send("Target.createTarget", { url: PROBE.login });
  await until("模拟登录生效", readLogin);
  console.log("✓ 接口请求带上了浏览器的登录状态");

  // 模拟服务器不回跨域响应头，读得到全靠清单的主机权限。
  const file = await evaluate(worker, `fetch(${JSON.stringify(PROBE.file)}, { credentials: "omit" }).then(async (response) => response.status + " " + (await response.text()))`);
  if (!file.startsWith("200 ")) throw new Error(`读不到字幕文件：${file}`);
  const lastApi = mock.requests.filter((entry) => apiHost(entry.host)).at(-1);
  const files = mock.requests.filter((entry) => fileHost(entry.host));
  if (!lastApi?.cookie.includes(PROBE.cookie)) throw new Error("接口请求没带登录状态");
  if (files.length === 0 || files.some((entry) => entry.cookie)) throw new Error("字幕文件请求不该带 Cookie");
  console.log("✓ 字幕文件靠主机权限读到，没带 Cookie");

  const read = await ask("transcript.get", { video: FIRST, mode: "full" });
  if (!read?.ok || read.value.transcript.cues.length === 0) throw new Error(`登录以后取不到字幕：${JSON.stringify(read)}`);
  if (read.value.official?.status !== "ok" || read.value.transcript.ref.kind === "official-ai") throw new Error(`官方总结没跟着字幕回来，或者拿它附带的字幕顶替了：${JSON.stringify(read.value.official)}`);
  const cached = await ask("transcript.get", { video: FIRST, mode: "cache-only" });
  if (!cached?.ok || !cached.value.fromCache || cached.value.official?.status !== "ok") throw new Error(`读到的字幕和官方总结没进本机缓存：${JSON.stringify(cached)}`);
  console.log(`✓ 登录以后后台读到 ${read.value.transcript.cues.length} 条字幕、${read.value.tracks.length} 条字幕轨和官方总结，存进了本机缓存`);

  mock.setScenario("paid");
  const paid = await ask("transcript.get", { video: SECOND, mode: "full" });
  mock.setScenario("");
  if (paid?.code !== "UNPLAYABLE") throw new Error(`付费视频应该报看不了：${JSON.stringify(paid)}`);
  console.log("✓ 付费视频读完视频信息就停下，报看不了");

  const { card } = await watch.notesAndOfficial(ask, FIRST);
  console.log("✓ 卡片显示官方总结，没配模型服务时摆「打开设置」；穿过透明层点笔记按钮、按 n 各存下一条笔记");
  await watch.generate(card, page, ANTHROPIC);
  console.log("✓ 配好模型服务后卡片换回「生成概览」，点一下出了章节和结论");
  await watch.wideScreen();
  console.log("✓ 宽屏时卡片挪到弹幕列表下面");
  // 第一个视频的概览卡片已经生成过，侧边栏用第二个视频从头走。
  await panelFlow(page, pageUrl, SECOND_ID).catch(async (error) => {
    // 卡住时把侧边栏上的文字带出来，看得出停在哪一步。
    const panel = [...sessions].find(([sessionId, info]) => info.url === pageUrl && sessionId !== page)?.[0];
    const shown = panel ? await evaluate(panel, `document.getElementById("app")?.innerText ?? ""`).catch(() => "") : "";
    throw new Error(`${error.message}\n侧边栏上显示：${shown}`);
  });
  await triageFlow({ until, evaluate, cdp, findSession, mock, extensionId: id, downloads });
  await watch.afterClear(page);
  console.log("✓ 清掉本机设置让启用失效，播放页上的笔记按钮和卡片不用刷新就全部撤下");

  // 启动期的报错可能晚一点才到，等一小会再查。
  await new Promise((done) => setTimeout(done, 500));
  if (errors.length > 0) throw new Error(`扩展有报错：\n${errors.join("\n")}`);
  console.log("✓ 没有报错");
  const stray = mock.requests.filter((entry) => entry.unexpected);
  if (stray.length > 0) throw new Error(`模拟服务器收到意外请求：${JSON.stringify(stray)}`);
  console.log(`✓ ${mock.requests.length} 个请求都在模拟路由里`);
} catch (error) {
  failed = true;
  console.error(`✗ ${error.message}`);
  // 无头模式的显示日志没有用，只会盖住真正的错误。
  const stderr = browser.stderr().split("\n").filter((line) => line && !line.includes("cv_display_link")).join("\n");
  if (stderr) console.error(`Chrome 的输出：\n${stderr.slice(-2000)}`);
} finally {
  browser.child.kill("SIGKILL");
  mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
