// YouTube 的端到端：日用包装进 Chrome for Testing，YouTube 观看页和模型服务都由本机模拟服务器扮演。
// 副本的清单里先写上 YouTube 的主机权限（无头 Chrome 里点不了授权框），装上就算已经启用：后台注册内容脚本。
// 在真实的侧边栏里走一遍：打开就只看本机、不读页面；还没读字幕时点播放器上解释当前画面的图标，只发画面，结果进侧边栏；
// 点读取时替用户点开文字稿，读到，标出轨和语言，这时再解释画面就带上前后几句；生成概览、存笔记、问答点引用跳转；
// 站内换到另一个视频，面板没更新时不认，更新后读到新视频的，不串台。
// 新式面板按播放器上已有的字幕轨判定来源：默认人工的标人工，只有一条自动轨的标自动，判定不了的标来源未确认。
// 点读取时简介里的入口还没出来（页面还在加载）：等它出来再点开，读得到。
// 播放页卡片插在右栏推荐视频上面、不进侧栏面板，本机没有字幕时不去读；侧边栏生成的结论卡片跟着摆出来，
// 精读时收起、速读时展开，窗口变窄时跟着推荐视频挪到播放器下面。
// 页面上没有文字稿、播放器有字幕的视频：点读取时简幕替用户开一下播放器的字幕，接住播放器自己取回的那份，读完关上，生成概览。
// 确实没有字幕的视频：卡片展开时问一句页面播放器上的字幕轨，直接说没有字幕，不摆「生成概览」，页面上什么都没点。
// 最后打开「打开就出结论」：新开的视频不用点，简幕替用户点开文字稿读完、关上，生成概览。
// 第一个加载：装的是日用包，之后导入的产品模块按日用构建的开关取值算。
import "../scripts/lib/daily-globals.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { videoKey } from "../src/core/video-ref.ts";
import { NO_CAPTIONS_TEXT, NOT_READ_TEXT } from "../src/pages/card/model.ts";
import { stillFalse } from "../tests/helpers/wait-until.ts";
import { CARD_HEIGHT } from "../src/content/card-frame.ts";
import { INJECTED } from "../src/shared/names.ts";
import { launchChrome, prepareExtension } from "./browser.mjs";
import { ANTHROPIC } from "./fixtures.mjs";
import { startMockServer } from "./mock-server.mjs";
import { QUIET_MEDIA_PATH } from "./watch-page.mjs";
import { storedSettings } from "./settings.mjs";
import { TUBE_CAPTION_PATH, TUBE_HOST, TUBE_TRACK_ADDRESS, TUBE_VIDEOS, tubeWatchPage } from "./youtube-page.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20_000;
const [FIRST_ID = "", SECOND_ID = ""] = Object.keys(TUBE_VIDEOS);
const FIRST = videoKey({ platform: "youtube", videoId: FIRST_ID });
/** 模拟观看页的标签页标题。 */
const TAB_TITLE = "样例观看页";

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

/** 嵌在某个观看页里的卡片框架：卡片框架都是同一个地址，按它所在的标签页认。 */
async function cardOf(watchUrl) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  for (const info of targetInfos.filter((item) => item.type === "iframe" && item.url.includes("/pages/card.html"))) {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
    await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    if ((await evaluate(sessionId, "chrome.tabs.getCurrent().then((tab) => tab?.url ?? '')")) === watchUrl) return sessionId;
  }
  return null;
}
const cardText = (card) => evaluate(card, `document.getElementById("card")?.textContent ?? ""`);
const cardCollapsed = (card) => evaluate(card, `document.getElementById("card")?.dataset.collapsed ?? ""`);

/**
 * 要看卡片上的内容。浏览器报得出侧边栏开关时（yields），侧边栏开着卡片就让位收着，像用户那样点开标题栏；
 * 报不出的老版本里，速读时卡片自己就是展开的。点开过的卡片在这个视频里以这一下为准，不再跟模式和侧边栏。
 */
async function openCard(card, yields) {
  if (yields) {
    await until("侧边栏开着，卡片让位收着", async () => (await cardCollapsed(card)) === "true");
    await evaluate(card, `(document.getElementById("card-toggle").click(), true)`);
  }
  await until("卡片展开", async () => (await cardCollapsed(card)) === "false");
}
/**
 * 手动收起再展开卡片：页面上的框架跟着卡片一帧一帧变高度，不是一下跳到头，最后和卡片一样高。
 * 只用在这个视频里手动点开过的卡片上：点完还是展开的，手动的那一下照旧算数。
 */
async function frameFollowsFold(video, card) {
  const frameHeight = `document.getElementById(${JSON.stringify(INJECTED.cardFrame)}).offsetHeight`;
  const cardHeight = () => evaluate(card, `Math.ceil(document.getElementById("card").getBoundingClientRect().height)`);
  // 从现在起每帧记一次框架的高度，到了 stop 那么高就停。
  const heightsUntil = async (stop, toggle) => {
    const watching = evaluate(
      video,
      `(async () => { const seen = []; const deadline = performance.now() + 5000; for (;;) { const now = ${frameHeight}; if (seen.at(-1) !== now) seen.push(now); if (now === ${stop} || performance.now() > deadline) return JSON.stringify(seen); await new Promise((done) => requestAnimationFrame(done)); } })()`,
    );
    await toggle();
    return JSON.parse(await watching);
  };
  const toggle = () => evaluate(card, `(document.getElementById("card-toggle").click(), true)`);
  // 框架滚出窗口时浏览器不给它画，卡片量不到自己的高度：先滚到眼前。内容刚摆好时框架还差一两帧，等两边一样高再开始。
  await evaluate(video, `(document.getElementById(${JSON.stringify(INJECTED.cardFrame)}).scrollIntoView({ block: "center" }), true)`);
  const full = await until("框架和展开着的卡片一样高", async () => {
    const [card, frame] = [await cardHeight(), await evaluate(video, frameHeight)];
    return card === frame && card > CARD_HEIGHT.min ? card : null;
  });
  const down = await heightsUntil(CARD_HEIGHT.min, toggle);
  const up = await heightsUntil(full, toggle);
  const steady = (heights, sign) => heights.every((height, index) => index === 0 || (height - heights[index - 1]) * sign > 0);
  if (down[0] !== full || down.at(-1) !== CARD_HEIGHT.min || down.length < 3 || !steady(down, -1)) throw new Error(`收起时框架的高度不是一路降到标题栏：${JSON.stringify(down)}`);
  if (up[0] !== CARD_HEIGHT.min || up.at(-1) !== full || up.length < 3 || !steady(up, 1)) throw new Error(`展开时框架的高度不是一路长回原来那么高：${JSON.stringify(up)}`);
  await until("展开以后卡片和原来一样高", async () => (await cardHeight()) === full);
}
/** 卡片框架在观看页上的位置：父节点、后一个节点的编号，在不在侧栏面板里。 */
const cardPlace = (video) =>
  evaluate(
    video,
    `(() => { const frame = document.getElementById(${JSON.stringify(INJECTED.cardFrame)}); if (!frame) return null; return { parent: frame.parentElement?.id ?? "", next: frame.nextElementSibling?.id ?? "", inPanel: Boolean(frame.closest("ytd-engagement-panel-section-list-renderer")) }; })()`,
  );
const placedAt = async (video, parent) => {
  const at = await cardPlace(video);
  return at?.parent === parent && at.next === "related" && !at.inPanel;
};

/** 经调试协议发的鼠标点击：浏览器派发的真实点击，简幕的图标只认这种。 */
async function mouseClick(session, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, session);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, session);
}

/** 页面主世界里给视频元素喂一路画布的媒体流：模拟页上的视频元素平时只放一段静音，没有画面。颜色是自造的。 */
const FEED_FRAMES = `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  const draw = () => {
    context.fillStyle = "rgb(48, 96, 200)";
    context.fillRect(0, 0, 640, 360);
    requestAnimationFrame(draw);
  };
  draw();
  const video = document.querySelector("video");
  video.srcObject = canvas.captureStream(30);
  await video.play();
  return true;
})()`;

/** 撤下画布的媒体流，视频元素回到原来那段静音：后面要跳时间点，媒体流跳不了。 */
const UNFEED_FRAMES = `(() => { document.querySelector("video").srcObject = null; return true; })()`;

/**
 * 点播放器上解释当前画面的图标：给视频喂上画面，真实点击图标，等侧边栏里多出一条解释，回这一次发给模型的解释画面请求。
 * 途中不读文字稿面板，也不替用户打开，不向 YouTube 发请求。
 */
async function explainFrame(video, panel, tubeCalls) {
  const tubeBefore = tubeCalls();
  const panelBefore = await evaluate(video, `document.querySelector("ytd-engagement-panel-section-list-renderer")?.getAttribute("visibility")`);
  await evaluate(video, FEED_FRAMES, true);
  await until("视频出了画面", () => evaluate(video, `document.querySelector("video").readyState >= 2 && document.querySelector("video").videoWidth > 0`));
  const icons = await until("浮层里笔记和解释当前画面两个图标", () =>
    evaluate(video, `(() => { const ids = [...document.querySelectorAll("#${INJECTED.overlay} > button")].map((node) => node.id); return ids.length === 2 ? ids : null; })()`),
  );
  if (icons.join() !== [INJECTED.noteButton, INJECTED.frameButton].join()) throw new Error(`浮层里的图标不对：${icons.join()}`);
  await cdp.send("Page.bringToFront", {}, video);
  // 侧边栏占掉一大块，无头窗口里剩下的视口比播放器还窄，图标落在视口外面：这一步把视口放宽。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, video);
  const spot = await until("解释当前画面的图标露出来", () =>
    evaluate(
      video,
      `(() => { const overlay = document.getElementById("${INJECTED.overlay}"); const node = document.getElementById("${INJECTED.frameButton}"); if (!overlay || !node || getComputedStyle(overlay).visibility !== "visible") return null; const box = node.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
    ),
  );
  const framesBefore = mock.requests.filter((entry) => entry.kind === "frame").length;
  const cardsBefore = await evaluate(panel, `document.querySelectorAll(".frame-card-text").length`);
  await mouseClick(video, spot.x, spot.y);
  let shown = "";
  const hint = await until("图标说结果去哪儿看", async () => {
    shown = await evaluate(video, `JSON.stringify([document.querySelector(".${INJECTED.frameLabel}")?.textContent ?? "", document.getElementById("${INJECTED.frameButton}")?.title ?? ""])`);
    const [text = ""] = JSON.parse(shown);
    return /结果在侧边栏|点简幕图标看结果/.test(text) ? text : null;
  }).catch((error) => {
    throw new Error(`${error.message}；图标上是 ${shown}`);
  });
  const explained = await until("侧边栏里多出这一帧的解释", async () => {
    const texts = await evaluate(panel, `[...document.querySelectorAll(".frame-card-text")].map((node) => node.textContent)`);
    return texts.length > cardsBefore && texts[0]?.includes("模拟服务的画面解释") ? texts[0] : null;
  });
  const stamp = await evaluate(panel, `document.querySelector(".frame-card .stamp")?.textContent ?? ""`);
  if (!/^\d+:\d{2}$/.test(stamp)) throw new Error(`画面卡片上没有时间：${stamp}`);
  const frames = mock.requests.filter((entry) => entry.kind === "frame").slice(framesBefore);
  if (frames.length !== 1 || !frames[0]?.image) throw new Error(`解释画面的请求不对：${JSON.stringify(frames)}`);
  if ((await evaluate(video, `document.querySelector("ytd-engagement-panel-section-list-renderer")?.getAttribute("visibility")`)) !== panelBefore) throw new Error("解释画面时动了文字稿面板");
  if (tubeCalls() !== tubeBefore) throw new Error("解释画面时向 YouTube 发了请求");
  await cdp.send("Emulation.clearDeviceMetricsOverride", {}, video);
  await evaluate(video, UNFEED_FRAMES);
  await until("视频元素回到原来的媒体", () => evaluate(video, `(() => { const node = document.querySelector("video"); return node.srcObject === null && node.duration > 300; })()`));
  return { hint, explained, sent: frames[0] };
}

/** 后台动态注册了哪些脚本，按编号排好、逗号连起来。 */
const registeredScripts = (worker) => evaluate(worker, `chrome.scripting.getRegisteredContentScripts().then((list) => list.map((item) => item.id).sort().join())`);

async function flow(launcher, panelUrl, worker) {
  await until("确认启用以后后台补注册了主世界的小桥", async () => (await registeredScripts(worker)) === "jianmu-youtube,jianmu-youtube-bridge");
  console.log("✓ 确认启用以后，后台注册了内容脚本和主世界的小桥");

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
  // 卡片插在右栏推荐视频上面，装文字稿的那一层在它前面；本机还没有字幕，卡片不去读，和 B 站一样摆「生成概览」。
  await until("卡片插在右栏推荐视频上面", () => placedAt(video, "secondary-inner"));
  const card = await until("观看页的卡片", () => cardOf(firstUrl));
  const yields = await evaluate(launcher, `Boolean(chrome.sidePanel.onOpened && chrome.sidePanel.onClosed)`);
  await openCard(card, yields);
  await until("卡片上摆着「生成概览」", () => evaluate(card, `Boolean(document.getElementById("card-generate"))`));
  if ((await cardText(card)).includes(NOT_READ_TEXT)) throw new Error("能代开文字稿的构建里卡片还让人先去侧边栏读");
  console.log("✓ 卡片插在右栏推荐视频上面，不进侧栏面板；本机还没有字幕时不去读，和 B 站一样摆「生成概览」");
  const modelCalls = () => mock.requests.filter((entry) => entry.host !== TUBE_HOST).length;
  // 页面自己取的图标和视频媒体不算：播放循环、浏览器取图标的时刻都不固定。
  const tubeCalls = () => mock.requests.filter((entry) => entry.host === TUBE_HOST && entry.path !== "/favicon.ico" && entry.path !== QUIET_MEDIA_PATH).length;
  if (await evaluate(video, `document.querySelector("ytd-engagement-panel-section-list-renderer")?.getAttribute("visibility")`) !== "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") throw new Error("打开视频时就替用户打开了文字稿");
  console.log("✓ 打开视频不读页面，也不替用户打开文字稿");
  // 还没读字幕：只发画面，前后字幕写「无」，标题取标签页的；文字稿面板照旧关着。
  const blind = await explainFrame(video, panel, tubeCalls);
  if (blind.sent.frame?.context !== "无" || blind.sent.frame?.title !== TAB_TITLE) throw new Error(`没读字幕时解释画面发的不对：${JSON.stringify(blind.sent.frame)}`);
  console.log(`✓ 还没读字幕时点播放器上解释当前画面的图标（「${blind.hint}」）：截到一帧、只发画面，侧边栏显示「${blind.explained.slice(0, 12)}…」；没读文字稿，也没替用户打开`);
  const before = modelCalls();
  const tubeBefore = tubeCalls();

  // 用户只点简幕的「读取字幕」：简幕替他点开文字稿，再读。
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  const [lineOne = "", lineTwo = ""] = TUBE_VIDEOS[FIRST_ID]?.lines ?? [];
  await until("读到文字稿", async () => (await textOf(panel, ".cue-text")).includes(lineTwo));
  await until("标题来自观看页", async () => (await textOf(panel, ".video-title")) === TUBE_VIDEOS[FIRST_ID]?.title);
  const cached = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video: FIRST, mode: "cache-only" } })})`);
  const ref = cached?.value?.transcript?.ref;
  if (!cached?.ok || ref?.lang !== "en" || ref?.kind !== "auto" || cached.value.transcript.label !== TUBE_VIDEOS[FIRST_ID]?.label) throw new Error(`轨的语言和来源不对：${JSON.stringify(cached?.value?.transcript?.ref ?? cached)}`);
  if (modelCalls() !== before || tubeCalls() !== tubeBefore) throw new Error("读文字稿时发了不该发的请求");
  console.log("✓ 点读取字幕时简幕替用户点开文字稿，读到，标出英文、自动生成，存进本机；YouTube 上没发任何请求");

  // 文字稿面板打开以后卡片还在面板下面，「生成概览」照旧在。
  if (!(await placedAt(video, "secondary-inner"))) throw new Error(`文字稿打开以后卡片不在原处：${JSON.stringify(await cardPlace(video))}`);
  await until("卡片上还摆着「生成概览」", () => evaluate(card, `Boolean(document.getElementById("card-generate"))`));
  console.log("✓ 文字稿面板开着时卡片排在面板下面，「生成概览」照旧在");

  // 读过字幕以后再解释画面：带上本机字幕里这一刻前后的几句，标题用本机记着的。
  const seen = await explainFrame(video, panel, tubeCalls);
  if (!seen.sent.frame?.context.includes(lineOne) || seen.sent.frame?.title !== TUBE_VIDEOS[FIRST_ID]?.title) throw new Error(`读过字幕以后解释画面发的不对：${JSON.stringify(seen.sent.frame)}`);
  console.log("✓ 读过字幕以后再点：带上本机字幕里这一刻前后的几句，标题用本机记着的");

  await until("生成概览可以点", () => clickIn(panel, "button", "生成概览"));
  await until("概览生成完", async () => (await textOf(panel, ".chapter-name")).includes("模拟服务写的章节"));
  await until("结论写好", async () => (await textOf(panel, ".verdict-text")).includes("模拟服务写的一句话结论"));
  console.log("✓ 生成概览：章节和一句话结论都显示出来");
  await until("卡片跟着摆出结论", async () => (await cardText(card)).includes("模拟服务写的一句话结论"));
  await until("卡片上也有章节", async () => (await cardText(card)).includes("模拟服务写的章节"));
  if ((await cardCollapsed(card)) !== "false") throw new Error("卡片该展开着");
  console.log("✓ 侧边栏生成的概览，卡片跟着摆出结论和章节");
  // 只在手动点开过的卡片上试：没点过的卡片再点一下，就不跟模式和侧边栏走了，后面的步骤要它跟。
  if (yields) {
    await frameFollowsFold(video, card);
    console.log("✓ 卡片收起、展开有过渡：页面上的框架一帧一帧跟着变高度，最后和卡片一样高");
  }

  await until("展开章节", () => clickIn(panel, ".chapter-toggle"));
  await until("把金句存为笔记", () => clickIn(panel, ".quote button", "存为笔记"));
  await until("存好笔记", async () => (await textOf(panel, ".notice-text")).includes("已存为笔记"));
  await until("在底下的提问框输入问题", () =>
    evaluate(panel, `(() => { const input = document.querySelector(".ask-entry input"); if (!input) return false; input.value = "这个视频讲了什么"; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`),
  );
  // 和按回车一样走表单提交：发出问题，打开问答抽屉。
  await until("回车提问", () => evaluate(panel, `(() => { const form = document.querySelector(".ask-entry"); if (!form) return false; form.requestSubmit(); return true; })()`));
  await until("问答抽屉打开", () => evaluate(panel, `[...document.querySelectorAll(".sheet")].some((node) => node.open && node.querySelector(".qa-form"))`));
  await until("回答回来", async () => (await textOf(panel, ".qa-answer")).includes("模拟服务的回答"));
  await evaluate(video, `(document.querySelector("video").currentTime = 100, true)`);
  await until("点回答里的引用", () => clickIn(panel, ".qa-answer .stamp"));
  await until("视频页跳到引用的时间点", async () => (await evaluate(video, `document.querySelector("video")?.currentTime ?? 100`)) < 5);
  await evaluate(panel, `(() => { const sheet = [...document.querySelectorAll(".sheet")].find((node) => node.open); sheet?.querySelector(".overlay-head [aria-label='关闭']")?.click(); return true; })()`);
  console.log(`✓ 金句存成笔记；问答带引用，点引用跳到视频里的时间点（第一句是「${lineOne}」）`);

  await until("切到精读", () => clickIn(panel, ".mode", "精读"));
  if (yields) {
    // 这张卡片前面手动点开过：这个视频里以那一下为准，切模式不再动它。
    await until("侧边栏进了精读", async () => (await evaluate(panel, `document.querySelector(".mode-view")?.getAttribute("aria-label")`)) === "精读");
    if (!(await stillFalse(async () => (await cardCollapsed(card)) !== "false", 20))) throw new Error("手动点开过的卡片不该跟着模式收起");
    await until("切回速读", () => clickIn(panel, ".mode", "速读"));
    console.log("✓ 手动点开过的卡片切模式不动");
  } else {
    await until("精读时卡片收起", async () => (await cardCollapsed(card)) === "true");
    await until("切回速读", () => clickIn(panel, ".mode", "速读"));
    await until("回到速读卡片展开", async () => (await cardCollapsed(card)) === "false");
    console.log("✓ 精读时卡片收起，回到速读展开");
  }

  // 窗口变窄：推荐视频挪到播放器下面，卡片跟过去；变宽再回右栏。挪过的卡片重新载入，结论照样在。
  await userClicks(video, "e2e-narrow");
  await until("卡片跟着推荐视频挪到播放器下面", () => placedAt(video, "below"));
  await userClicks(video, "e2e-narrow");
  await until("卡片回到右栏", () => placedAt(video, "secondary-inner"));
  const moved = await until("挪过的卡片", () => cardOf(firstUrl));
  await until("挪过以后结论还在", async () => (await cardText(moved)).includes("模拟服务写的一句话结论"));
  console.log("✓ 窗口变窄时卡片跟着推荐视频挪到播放器下面，变宽回到右栏，结论照样在");

  // 站内换到另一个视频：面板还留着上一个视频的内容，读取时不认；用户重新打开以后读到新视频的。
  await userClicks(video, "e2e-next");
  await until("侧边栏跟到新视频，让用户点读取", async () => (await stateTitle(panel)).includes("读取这个视频的字幕"));
  const secondCard = await until("换视频以后的卡片", () => cardOf(tubeWatchPage(SECOND_ID)));
  await openCard(secondCard, yields);
  await until("卡片跟到新视频，本机还没有字幕时摆「生成概览」", () => evaluate(secondCard, `Boolean(document.getElementById("card-generate"))`));
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await until("说文字稿还没换过来", async () => (await stateTitle(panel)).includes("还没换成这个视频的"));
  await userClicks(video, "e2e-close-transcript");
  await userClicks(video, "e2e-open-transcript");
  await until("点重试", () => clickIn(panel, ".state-block .button", "重试"));
  const [, secondLine = ""] = TUBE_VIDEOS[SECOND_ID]?.lines ?? [];
  await until("读到新视频的文字稿", async () => (await textOf(panel, ".cue-text")).includes(secondLine));
  await until("标题换成新视频的", async () => (await textOf(panel, ".video-title")) === TUBE_VIDEOS[SECOND_ID]?.title);
  const firstAgain = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video: FIRST, mode: "cache-only" } })})`);
  if (!firstAgain?.ok || !firstAgain.value.transcript.cues.some((cue) => cue.text === lineOne)) throw new Error(`上一个视频的字幕被改了：${JSON.stringify(firstAgain)}`);
  console.log("✓ 站内换视频：卡片跟到新视频；面板没更新时不认，更新后读到新视频的，上一个视频的字幕不受影响");

  await modernFlow(launcher, panel, worker, windowId);
}

/** 在本窗口新开一个观看页，等侧边栏跟过去、页面连上。 */
async function openWatch(launcher, panel, worker, windowId, id) {
  const url = tubeWatchPage(id);
  await evaluate(launcher, `chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(url)} }).then(() => true)`);
  const video = await until(`观看页 ${id} 打开`, () => findSession("page", url));
  await until("侧边栏跟过去，让用户点读取", async () => (await stateTitle(panel)).includes("读取这个视频的字幕"));
  const tabId = await evaluate(panel, `chrome.tabs.query({ windowId: ${windowId} }).then((tabs) => tabs.find((tab) => tab.url === ${JSON.stringify(url)})?.id)`);
  await until("视频页连上", () => evaluate(worker, `chrome.tabs.sendMessage(${tabId}, ${JSON.stringify({ type: "youtube.current", req: { videoId: id } })}, { frameId: 0 }).then((reply) => reply?.videoId === ${JSON.stringify(id)}, () => false)`));
  return video;
}

/** 本机存着的这个视频的字幕：语言、来源和轨名。 */
async function cachedTrack(panel, id) {
  const video = videoKey({ platform: "youtube", videoId: id });
  const cached = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video, mode: "cache-only" } })})`);
  const transcript = cached?.value?.transcript;
  return { lang: transcript?.ref?.lang, kind: transcript?.ref?.kind, label: transcript?.label };
}

async function expectTrack(panel, id, expected) {
  const found = await cachedTrack(panel, id);
  if (JSON.stringify(found) !== JSON.stringify(expected)) throw new Error(`${id} 的轨不对：${JSON.stringify(found)}，应是 ${JSON.stringify(expected)}`);
}

/** 新式面板：页面上留着两个关着的空壳；有章节时选着章节页签要提示切过去，切回文字稿以后读得到；没章节的直接读；搜索框里有字时不交。 */
async function modernFlow(launcher, panel, worker, windowId) {
  const [, , CHAPTERS_ID = "", PLAIN_ID = "", UNMARKED_ID = ""] = Object.keys(TUBE_VIDEOS);
  const lastLine = (id) => TUBE_VIDEOS[id]?.lines.at(-1) ?? "";

  const chaptersPage = await openWatch(launcher, panel, worker, windowId, CHAPTERS_ID);
  await userClicks(chaptersPage, "e2e-open-transcript");
  await until("文字稿放进面板", () => evaluate(chaptersPage, `document.querySelectorAll("transcript-segment-view-model").length > 0`));
  await userClicks(chaptersPage, "e2e-chapters-tab");
  // 选着章节时点读取：简幕替用户切到文字稿那一页，再读。
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await until("读到新式面板的文字稿", async () => (await textOf(panel, ".cue-text")).includes(lastLine(CHAPTERS_ID)));
  const cueTexts = await textOf(panel, ".cue-text");
  if (/seconds|Intro/.test(cueTexts)) throw new Error(`把给读屏的那句或章节标题当成了字幕：${cueTexts}`);
  if (await evaluate(chaptersPage, `document.body.hasAttribute("data-e2e-wrong-entry")`)) throw new Error("点了关着的面板里那个入口");
  await expectTrack(panel, CHAPTERS_ID, { lang: "en", kind: "human", label: "English" });
  console.log("✓ 新式面板带章节：选着章节时点读取，简幕替用户切到文字稿那一页；两个关着的空壳不碍事，不带读屏的那句和章节标题；人工和自动都有时按默认轨标成人工");

  const plainPage = await openWatch(launcher, panel, worker, windowId, PLAIN_ID);
  // 用户自己打开、在搜索框里打了字：简幕不点，提示清掉搜索词。
  await userClicks(plainPage, "e2e-open-transcript");
  await until("文字稿放进面板", () => evaluate(plainPage, `document.querySelectorAll("transcript-segment-view-model").length > 0`));
  await evaluate(plainPage, `(document.getElementById("e2e-search").value = "plain", true)`, true);
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await until("说搜索框里有字", async () => (await stateTitle(panel)).includes("搜索词"));
  await evaluate(plainPage, `(document.getElementById("e2e-search").value = "", true)`, true);
  await until("点重试", () => clickIn(panel, ".state-block .button", "重试"));
  await until("读到没章节的新式面板", async () => (await textOf(panel, ".cue-text")).includes(lastLine(PLAIN_ID)));
  if (await evaluate(plainPage, `document.body.hasAttribute("data-e2e-wrong-entry")`)) throw new Error("点了关着的面板里那个入口");
  await expectTrack(panel, PLAIN_ID, { lang: "en", kind: "auto", label: "English (auto-generated)" });
  await until("侧边栏上显示轨名", async () => (await textOf(panel, ".video-meta")).includes("English (auto-generated)"));
  console.log("✓ 新式面板没章节：搜索框里有字时不点也不交，清掉以后读到；只有一条自动轨，标成自动生成");

  // 两条轨、没有默认轨：判定不了，标来源未确认，不猜。
  await openWatch(launcher, panel, worker, windowId, UNMARKED_ID);
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await until("读到没有默认轨的新式面板", async () => (await textOf(panel, ".cue-text")).includes(lastLine(UNMARKED_ID)));
  await expectTrack(panel, UNMARKED_ID, { lang: "und", kind: "unconfirmed", label: "YouTube 文字稿（来源未确认）" });
  await until("侧边栏上照实说来源未确认", async () => (await textOf(panel, ".video-meta")).includes("来源未确认"));
  if (mock.requests.some((entry) => entry.path === TUBE_TRACK_ADDRESS)) throw new Error("读了播放器数据里的字幕地址");
  console.log("✓ 新式面板有两条轨、没有默认轨：标来源未确认；播放器数据里的字幕地址没人去读");

  await lateEntryFlow(launcher, panel, worker, windowId);
  await cardGenerateFlow(launcher, panel, worker, windowId);
  await caughtCaptionsFlow(launcher, panel, worker, windowId);
  await noCaptionsFlow(launcher, panel, worker, windowId);
  await autoFlow(launcher, panel, worker, windowId);
}

/** 点读取时简介里还没有文字稿入口，页面过一会儿才放上去：简幕等它出来再点开，读得到，不报找不到文字稿。 */
async function lateEntryFlow(launcher, panel, worker, windowId) {
  const LATE_ID = "jmTube00008";
  const page = await openWatch(launcher, panel, worker, windowId, LATE_ID);
  if (await evaluate(page, `Boolean(document.getElementById("e2e-open-transcript"))`)) throw new Error("入口一开始就在");
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  await evaluate(page, "e2eShowEntryLater(1500)");
  await until("入口出来以后读到文字稿", async () => (await textOf(panel, ".cue-text")).includes(TUBE_VIDEOS[LATE_ID]?.lines.at(-1) ?? "")).catch(async (error) => {
    throw new Error(`${error.message}；侧边栏上是「${await stateTitle(panel)}」`);
  });
  if (await evaluate(page, `document.body.hasAttribute("data-e2e-wrong-entry")`)) throw new Error("点了关着的面板里那个入口");
  console.log("✓ 入口晚出来：点读取时简介里还没有入口，简幕等它出来再点开，读到了，没报找不到文字稿");
}

/** 卡片上点「生成概览」：本机还没有字幕，简幕经这个视频页替用户点开文字稿读完、关上，再生成，结论摆在卡片上。 */
async function cardGenerateFlow(launcher, panel, worker, windowId) {
  const CARD_ID = "jmTube00007";
  const url = tubeWatchPage(CARD_ID);
  const page = await openWatch(launcher, panel, worker, windowId, CARD_ID);
  const card = await until("观看页的卡片", () => cardOf(url));
  await openCard(card, await evaluate(launcher, `Boolean(chrome.sidePanel.onOpened && chrome.sidePanel.onClosed)`));
  await until("卡片上摆着「生成概览」", () => evaluate(card, `Boolean(document.getElementById("card-generate"))`));
  await cdp.send("Page.bringToFront", {}, page);
  // 侧边栏占掉一大块，无头窗口里剩下的视口太窄、卡片被挤扁：把窗口真的拉大（模拟视口尺寸时点击进不了卡片框架），做完再还原。
  const { windowId: browserWindow, bounds } = await cdp.send("Browser.getWindowForTarget", {}, page);
  await cdp.send("Browser.setWindowBounds", { windowId: browserWindow, bounds: { width: 1700, height: 1000 } });
  // 标签页到了前台卡片才开始展开，框架跟着卡片报的高度变高，卡片的视口和画出来的那一块又比页面上的框架晚一两帧：
  // 没跟上的那一截按下去落在页面上，卡片收不到。等过渡走完、卡片的视口和框架一样大、
  // 按钮整个露在视口里、按钮中心点到的就是它，并且连着两次量到的都一样，再点。
  let previous = "";
  const { frame, button } = await until("「生成概览」停在卡片框架里", async () => {
    const at = await evaluate(page, `(() => { const node = document.getElementById(${JSON.stringify(INJECTED.cardFrame)}); if (!node) return null; node.scrollIntoView({ block: "start" }); const box = node.getBoundingClientRect(); return { x: box.left, y: box.top, width: box.width, height: box.height }; })()`);
    const spot = await evaluate(
      card,
      `(() => { const node = document.getElementById("card-generate"); if (!node) return null; const box = node.getBoundingClientRect(); const x = box.left + box.width / 2; const y = box.top + box.height / 2; return { x, y, top: box.top, bottom: box.bottom, viewWidth: innerWidth, viewHeight: innerHeight, moving: document.getAnimations().some((item) => item.playState === "running"), hit: document.elementFromPoint(x, y)?.closest("#card-generate") === node }; })()`,
    );
    const now = JSON.stringify({ at, spot });
    const steady = now === previous;
    previous = now;
    if (!at || !spot || spot.moving || !spot.hit || !steady) return null;
    const fits = Math.abs(spot.viewWidth - at.width) < 1 && Math.abs(spot.viewHeight - at.height) < 1 && spot.top >= 0 && spot.bottom <= spot.viewHeight;
    return fits ? { frame: at, button: spot } : null;
  });
  await mouseClick(page, frame.x + button.x, frame.y + button.y);
  const video = videoKey({ platform: "youtube", videoId: CARD_ID });
  await until("卡片上摆出结论", async () => (await cardText(card)).includes("模拟服务写的一句话结论")).catch(async (error) => {
    const panelState = await evaluate(page, `document.getElementById("e2e-open-panel")?.getAttribute("visibility") ?? ""`);
    const hit = await evaluate(page, `(() => { const node = document.elementFromPoint(${frame.x + button.x}, ${frame.y + button.y}); return node ? node.tagName + "#" + node.id : "无"; })()`);
    const now = await evaluate(page, `JSON.stringify(document.getElementById(${JSON.stringify(INJECTED.cardFrame)})?.getBoundingClientRect())`);
    throw new Error(`${error.message}；卡片上是「${await cardText(card)}」，文字稿面板 ${panelState}，点的位置 ${JSON.stringify({ frame, button })}，那里是 ${hit}，卡片框架现在在 ${now}`);
  });
  await until("简幕读完关上了文字稿", () => evaluate(page, `document.body.hasAttribute("data-e2e-panel-closed")`));
  const cached = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video, mode: "cache-only" } })})`);
  if (!cached?.ok || !cached.value.transcript.cues.some((cue) => cue.text === TUBE_VIDEOS[CARD_ID]?.lines.at(-1))) throw new Error(`字幕没读对：${JSON.stringify(cached)}`);
  await cdp.send("Browser.setWindowBounds", { windowId: browserWindow, bounds: { width: bounds.width, height: bounds.height } });
  console.log("✓ 卡片上点「生成概览」：本机还没有字幕，简幕经视频页替用户点开文字稿读完、关上，生成后结论摆在卡片上");
}

/**
 * 页面上没有文字稿入口、播放器有字幕：点读取，简幕等不到入口，改替用户点一下播放器的字幕按钮，接住播放器自己取回的字幕，
 * 读完再点一下关上；按播放器的轨标成人工英文。简幕自己不向 YouTube 发请求，播放器只取了一次。然后生成概览。
 */
async function caughtCaptionsFlow(launcher, panel, worker, windowId) {
  const PLAYER_ID = "jmTube00009";
  const page = await openWatch(launcher, panel, worker, windowId, PLAYER_ID);
  const captionCalls = () => mock.requests.filter((entry) => entry.host === TUBE_HOST && entry.path === TUBE_CAPTION_PATH).length;
  const before = captionCalls();
  await until("点读取字幕", () => clickIn(panel, ".state-block .button", "读取字幕"));
  const lines = TUBE_VIDEOS[PLAYER_ID]?.lines ?? [];
  await until("读到播放器取回的字幕", async () => (await textOf(panel, ".cue-text")).includes(lines.at(-1) ?? "")).catch(async (error) => {
    throw new Error(`${error.message}；侧边栏上是「${await stateTitle(panel)}」`);
  });
  const cues = await textOf(panel, ".cue-text");
  if (!cues.includes(lines[1] ?? "-")) throw new Error(`分片段的那句没拼好：${cues}`);
  await expectTrack(panel, PLAYER_ID, { lang: "en", kind: "human", label: "English" });
  const state = await evaluate(page, `JSON.stringify([document.getElementById("e2e-captions").getAttribute("aria-pressed"), document.body.dataset.e2eCaptionFetches ?? "0"])`);
  if (state !== JSON.stringify(["false", "1"])) throw new Error(`字幕按钮没有点一下开、读完点一下关：${state}`);
  if (captionCalls() - before !== 1) throw new Error(`播放器取字幕的次数不对：${captionCalls() - before}`);
  if (mock.requests.slice(-50).some((entry) => entry.host === TUBE_HOST && entry.unexpected)) throw new Error("YouTube 上有意外请求");
  console.log("✓ 页面上没有文字稿：简幕替用户开一下播放器的字幕，接住播放器自己取回的那份，读完关上；标成人工英文，播放器只取了一次");
  await until("生成概览可以点", () => clickIn(panel, "button", "生成概览"));
  await until("结论写好", async () => (await textOf(panel, ".verdict-text")).includes("模拟服务写的一句话结论"));
  console.log("✓ 用播放器字幕生成了概览");
}

/** 确实没有字幕的视频：卡片展开就说没有字幕，不摆「生成概览」；只问了页面，没点任何东西，也没向 YouTube 发请求。 */
async function noCaptionsFlow(launcher, panel, worker, windowId) {
  const NONE_ID = "jmTube00010";
  const url = tubeWatchPage(NONE_ID);
  const page = await openWatch(launcher, panel, worker, windowId, NONE_ID);
  const before = mock.requests.length;
  const card = await until("观看页的卡片", () => cardOf(url));
  await openCard(card, await evaluate(launcher, `Boolean(chrome.sidePanel.onOpened && chrome.sidePanel.onClosed)`));
  await until("卡片说没有字幕", async () => (await cardText(card)).includes(NO_CAPTIONS_TEXT)).catch(async (error) => {
    throw new Error(`${error.message}；卡片上是「${await cardText(card)}」`);
  });
  if (await evaluate(card, `Boolean(document.getElementById("card-generate"))`)) throw new Error("没有字幕还摆着「生成概览」");
  const panelState = await evaluate(page, `document.getElementById("e2e-open-panel")?.getAttribute("visibility") ?? ""`);
  if (panelState !== "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") throw new Error(`页面上的面板被动过：${panelState}`);
  if (mock.requests.slice(before).some((entry) => entry.host === TUBE_HOST && !["/watch", "/favicon.ico", QUIET_MEDIA_PATH].includes(entry.path))) throw new Error("卡片判断有没有字幕时向 YouTube 发了请求");
  console.log("✓ 确实没有字幕的视频：卡片展开就说没有字幕，不摆「生成概览」，页面上什么都没点、没发请求");
}

/** 打开就出结论：门槛调到 0，新开的视频不用点就生成；简幕替用户点开文字稿，读完关上；YouTube 上不发请求。 */
async function autoFlow(launcher, panel, worker, windowId) {
  const AUTO_ID = "jmTube00006";
  const auto = await storedSettings(ANTHROPIC, { minutes: 0 });
  await evaluate(launcher, `chrome.storage.local.set(${JSON.stringify(auto.local)}).then(() => true)`);
  const url = tubeWatchPage(AUTO_ID);
  await evaluate(launcher, `chrome.tabs.create({ windowId: ${windowId}, url: ${JSON.stringify(url)} }).then(() => true)`);
  const page = await until(`观看页 ${AUTO_ID} 打开`, () => findSession("page", url));
  const video = videoKey({ platform: "youtube", videoId: AUTO_ID });
  const verdict = () => evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "overview.get", req: { video } })}).then((reply) => reply?.value?.overview?.analysis?.verdict?.summary ?? "")`);
  await until("不用点就生成了结论", async () => (await verdict()).includes("模拟服务写的一句话结论"));
  await until("简幕读完关上了文字稿", () => evaluate(page, `document.body.hasAttribute("data-e2e-panel-closed")`));
  const visibility = await evaluate(page, `document.getElementById("e2e-open-panel").getAttribute("visibility")`);
  if (visibility !== "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN") throw new Error(`读完面板还开着：${visibility}`);
  const cached = await evaluate(panel, `chrome.runtime.sendMessage(${JSON.stringify({ type: "transcript.get", req: { video, mode: "cache-only" } })})`);
  if (!cached?.ok || !cached.value.transcript.cues.some((cue) => cue.text === TUBE_VIDEOS[AUTO_ID]?.lines.at(-1))) throw new Error(`字幕没读对：${JSON.stringify(cached)}`);
  console.log("✓ 打开就出结论：新开的 YouTube 视频不用点，简幕替用户点开文字稿读完、关上，生成了结论");
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
  // 装上时已有 YouTube 授权、还没确认启用：只注册内容脚本，接字幕的小桥要等确认。
  const before = await until("后台注册了 YouTube 的内容脚本", () => registeredScripts(worker));
  if (before !== "jianmu-youtube") throw new Error(`确认启用之前注册的脚本不对：${before}`);
  console.log("✓ 已有 YouTube 授权、还没确认启用：只注册了内容脚本，没有主世界的小桥");
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
