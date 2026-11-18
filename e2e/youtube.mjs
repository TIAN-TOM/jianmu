// YouTube 的端到端：日用包装进 Chrome for Testing，YouTube 观看页和模型服务都由本机模拟服务器扮演。
// 副本的清单里先写上 YouTube 的主机权限（无头 Chrome 里点不了授权框），装上就算已经启用：后台注册内容脚本。
// 在真实的侧边栏里走一遍：打开就只看本机、不读页面；没打开文字稿时点读取，说明要先打开；用户打开以后读到，
// 标出轨和语言；生成概览、存笔记、问答点引用跳转；站内换到另一个视频，面板没更新时不认，更新后读到新视频的，不串台。
// 第一个加载：装的是日用包，之后导入的产品模块按日用构建的开关取值算。
import "../scripts/lib/daily-globals.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { videoKey } from "../src/core/video-ref.ts";
import { launchChrome, prepareExtension } from "./browser.mjs";
import { ANTHROPIC } from "./fixtures.mjs";
import { startMockServer } from "./mock-server.mjs";
import { storedSettings } from "./settings.mjs";
import { TUBE_HOST, TUBE_VIDEOS, tubeWatchPage } from "./youtube-page.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20_000;
const [FIRST_ID = "", SECOND_ID = ""] = Object.keys(TUBE_VIDEOS);
const FIRST = videoKey({ platform: "youtube", videoId: FIRST_ID });

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
const work = mkdtempSync(join(tmpdir(), "jianmu-e2e-youtube-"));
const extensionDir = join(work, "extension");
prepareExtension({ zip: join(ROOT, "dist", `jianmu-${version}-daily.zip`), dir: extensionDir, origins: [ANTHROPIC.origin, `https://${TUBE_HOST}`] });

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
  for (const [sessionId, info] of sessions) if (info.type === type && info.url === url) return sessionId;
  return null;
}

async function evaluate(sessionId, expression, userGesture = false) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

const clickIn = (session, selector, text = "") =>
  evaluate(
    session,
    `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find((item) => item.textContent.includes(${JSON.stringify(text)}) && !item.disabled); if (!node) return false; node.click(); return true; })()`,
  );
const textOf = (session, selector) => evaluate(session, `[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent).join("\\n")`);
const stateTitle = (panel) => textOf(panel, ".state-block .state-title");
/** 视频页上扮演用户的按钮：真实点击，不是简幕点的。 */
const userClicks = (video, id) => evaluate(video, `(document.getElementById(${JSON.stringify(id)}).click(), true)`, true);

async function flow(launcher, panelUrl, worker) {
  const registered = await until("后台注册了 YouTube 的内容脚本", () => evaluate(worker, `chrome.scripting.getRegisteredContentScripts().then((list) => list.map((item) => item.id).join())`));
  if (!registered.includes("jianmu-youtube")) throw new Error(`注册的脚本不对：${registered}`);
  console.log("✓ 已有 YouTube 授权，后台注册了内容脚本");

  const windowId = await evaluate(launcher, "chrome.tabs.getCurrent().then((tab) => chrome.sidePanel.open({ windowId: tab.windowId }).then(() => tab.windowId))", true);
  const panel = await until("侧边栏打开", () => {
    for (const [sessionId, info] of sessions) if (info.url === panelUrl && sessionId !== launcher && (info.type === "page" || info.type === "other")) return sessionId;
    return null;
  });
  const firstUrl = tubeWatchPage(FIRST_ID);
  await evaluate(launcher, `chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(firstUrl)} }).then(() => true)`);
  const video = await until("观看页打开", () => findSession("page", firstUrl));

  // 打开就只看本机：没有缓存时只给「读取字幕」，不去读页面。
  await until("侧边栏让用户点读取", async () => (await stateTitle(panel)).includes("读取这个视频的字幕"));
  // 内容脚本挂上、过了启用闸门才回话：从后台问一句当前视频，回得上来就算页面连上了。
  const tabId = await evaluate(panel, `chrome.tabs.query({ windowId: ${windowId} }).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(firstUrl)})?.id)`);
  await until("视频页连上", () => evaluate(worker, `chrome.tabs.sendMessage(${tabId}, ${JSON.stringify({ type: "youtube.current", req: { videoId: FIRST_ID } })}, { frameId: 0 }).then((reply) => reply?.videoId === ${JSON.stringify(FIRST_ID)}, () => false)`));
  const modelCalls = () => mock.requests.filter((entry) => entry.host !== TUBE_HOST).length;
  const before = modelCalls();
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await until("说要先打开文字稿", async () => (await stateTitle(panel)).includes("文字稿还没打开"));
  console.log("✓ 打开视频不读页面；文字稿没打开时点读取，说明要先打开");

  await userClicks(video, "e2e-open-transcript");
  await until("点重试", () => clickIn(panel, ".state-block .button", "重试"));
  const [lineOne = "", lineTwo = ""] = TUBE_VIDEOS[FIRST_ID]?.lines ?? [];
  await until("读到文字稿", async () => (await textOf(panel, ".cue-text")).includes(lineTwo));
  await until("标题来自观看页", async () => (await textOf(panel, ".video-title")) === TUBE_VIDEOS[FIRST_ID]?.title);
  const cached = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video: FIRST, mode: "cache-only" } })})`);
  const ref = cached?.value?.transcript?.ref;
  if (!cached?.ok || ref?.lang !== "en" || ref?.kind !== "auto" || cached.value.transcript.label !== TUBE_VIDEOS[FIRST_ID]?.label) throw new Error(`轨的语言和来源不对：${JSON.stringify(cached?.value?.transcript?.ref ?? cached)}`);
  if (modelCalls() !== before) throw new Error("读文字稿时发了不该发的请求");
  console.log("✓ 用户打开文字稿以后读到，标出英文、自动生成，存进本机；YouTube 上没发任何请求");

  await until("生成概览可以点", () => clickIn(panel, "button", "生成概览"));
  await until("概览生成完", async () => (await textOf(panel, ".chapter-name")).includes("模拟服务写的章节"));
  await until("结论写好", async () => (await textOf(panel, ".verdict-text")).includes("模拟服务写的一句话结论"));
  console.log("✓ 生成概览：章节和一句话结论都显示出来");

  await until("展开章节", () => clickIn(panel, ".chapter-toggle"));
  await until("把金句存为笔记", () => clickIn(panel, ".quote button", "存为笔记"));
  await until("存好笔记", async () => (await textOf(panel, ".notice-text")).includes("已存为笔记"));
  await until("打开问答抽屉", () => clickIn(panel, ".ask-entry"));
  await until("提问框可以用", () =>
    evaluate(panel, `(() => { const input = document.querySelector(".qa-form input"); if (!input) return false; input.value = "这个视频讲了什么"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`),
  );
  await until("提问", () => clickIn(panel, ".qa-form button", "提问"));
  await until("回答回来", async () => (await textOf(panel, ".qa-answer")).includes("模拟服务的回答"));
  await evaluate(video, `(document.querySelector("video").currentTime = 100, true)`);
  await until("点回答里的引用", () => clickIn(panel, ".qa-answer .stamp"));
  await until("视频页跳到引用的时间点", async () => (await evaluate(video, `document.querySelector("video")?.currentTime ?? 100`)) < 5);
  await evaluate(panel, `(() => { const sheet = [...document.querySelectorAll(".sheet")].find((node) => node.open); sheet?.querySelector(".overlay-head [aria-label='关闭']")?.click(); return true; })()`);
  console.log(`✓ 金句存成笔记；问答带引用，点引用跳到视频里的时间点（第一句是「${lineOne}」）`);

  // 站内换到另一个视频：面板还留着上一个视频的内容，读取时不认；用户重新打开以后读到新视频的。
  await userClicks(video, "e2e-next");
  await until("侧边栏跟到新视频，让用户点读取", async () => (await stateTitle(panel)).includes("读取这个视频的字幕"));
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await until("说文字稿还没换过来", async () => (await stateTitle(panel)).includes("还没换成这个视频的"));
  await userClicks(video, "e2e-open-transcript");
  await until("点重试", () => clickIn(panel, ".state-block .button", "重试"));
  const [, secondLine = ""] = TUBE_VIDEOS[SECOND_ID]?.lines ?? [];
  await until("读到新视频的文字稿", async () => (await textOf(panel, ".cue-text")).includes(secondLine));
  await until("标题换成新视频的", async () => (await textOf(panel, ".video-title")) === TUBE_VIDEOS[SECOND_ID]?.title);
  const firstAgain = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video: FIRST, mode: "cache-only" } })})`);
  if (!firstAgain?.ok || !firstAgain.value.transcript.cues.some((cue) => cue.text === lineOne)) throw new Error(`上一个视频的字幕被改了：${JSON.stringify(firstAgain)}`);
  console.log("✓ 站内换视频：面板没更新时不认，更新后读到新视频的，上一个视频的字幕不受影响");
}

let failed = false;
try {
  const { product } = await cdp.send("Browser.getVersion", {}, undefined, TIMEOUT_MS);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { id } = await browser.loadExtension(TIMEOUT_MS);
  console.log(`✓ ${product} 装上了日用包 ${id}`);
  const worker = await until("service worker 启动", () => findSession("service_worker", `chrome-extension://${id}/background.js`));

  const pageUrl = `chrome-extension://${id}/pages/sidepanel.html`;
  await cdp.send("Target.createTarget", { url: pageUrl });
  const launcher = await until("启动用的侧边栏页面打开", () => findSession("page", pageUrl));
  await until("启动页渲染出内容", () => evaluate(launcher, 'document.getElementById("app")?.textContent ?? ""'));
  const stored = await storedSettings(ANTHROPIC);
  await evaluate(launcher, `Promise.all([chrome.storage.local.set(${JSON.stringify(stored.local)}), chrome.storage.session.set(${JSON.stringify(stored.session)})]).then(() => true)`);
  await flow(launcher, pageUrl, worker).catch(async (error) => {
    const panel = [...sessions].find(([sessionId, info]) => info.url === pageUrl && sessionId !== launcher)?.[0];
    const shown = panel ? await evaluate(panel, `document.getElementById("app")?.innerText ?? ""`).catch(() => "") : "";
    throw new Error(`${error.message}\n侧边栏上显示：${shown}`);
  });

  await new Promise((done) => setTimeout(done, 500));
  if (errors.length > 0) throw new Error(`扩展有报错：\n${errors.join("\n")}`);
  console.log("✓ 没有报错");
  const stray = mock.requests.filter((entry) => entry.unexpected);
  if (stray.length > 0) throw new Error(`模拟服务器收到意外请求：${JSON.stringify(stray)}`);
  console.log(`✓ ${mock.requests.length} 个请求都在模拟路由里`);
} catch (error) {
  failed = true;
  console.error(`✗ ${error.message}`);
  const stderr = browser.stderr().split("\n").filter((line) => line && !line.includes("cv_display_link")).join("\n");
  if (stderr) console.error(`Chrome 的输出：\n${stderr.slice(-2000)}`);
} finally {
  browser.child.kill("SIGKILL");
  mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
