// 生命周期冒烟：任务在真实 Chrome 里跨过 service worker 的空闲回收、被强行终止时是什么样子。
// - 登记了却没人认领的任务按真实计时到点收尾；强行终止后再唤醒，任务表是空的，不恢复、不重发。
// - 发起概览的页面关掉以后，模型请求挂过空闲回收点，worker 一直在，请求回来后任务跑完、概览和结论存进本机。
// - 读视频信息和字幕很慢、这段没有模型请求时关掉页面，只靠整个任务的保活撑过回收点，任务照样跑完。
// - 模型请求在途时强行终止 worker：挂着的请求断了，任务表是空的，模拟服务等一会儿也没收到重发，再发起一次能跑完。
//
//   npm run test:e2e:lifecycle   打包后运行，约两分半；用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
//
// 单独成一个脚本，不放进 run.mjs：那边给 service worker 挂了调试器，挂着调试器 Chrome 就不回收 worker，
// 这里要看它被回收、被终止的样子。所以只附加扩展页面，从不附加 worker。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { videoKey } from "../src/core/video-ref.ts";
import { createSettingsStore } from "../src/platform/settings-store.ts";
import { PAGE_PATHS } from "../src/shared/names.ts";
import { launchChrome, prepareExtension } from "./browser.mjs";
import { ANTHROPIC, OPENAI, VIDEOS } from "./fixtures.mjs";
import { PROBE, slowed, startMockServer } from "./mock-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT_MS = 20_000;
const HARD_TIMEOUT_MS = 300_000;
// 后台的认领时限是 15 秒。收尾早于这个时间说明不是按时限收的；晚太多说明计时器没起作用。
const CLAIM_MS = 15_000;
const CLAIM_LATEST_MS = CLAIM_MS + 10_000;
// Chrome 在 worker 空闲约 30 秒后回收它；挂住的时长要跨过这个点再多一截，才说明确实是保活撑住的。
const IDLE_SHUTDOWN_MS = 30_000;
const PAST_IDLE_MS = IDLE_SHUTDOWN_MS + 3000;
// 慢场景里每个读取拖这么久：短于读取实现的单次时限（12 秒），四个连起来远超空闲回收点。
const SLOW_READ_MS = 11_000;
// 终止之后至少看这么久，确认没有谁自动重发。
const NO_RESEND_WINDOW_MS = 3000;
const [FIRST_ID = "", SECOND_ID = ""] = Object.keys(VIDEOS);
const FIRST = videoKey({ platform: "bilibili", videoId: FIRST_ID });
const SECOND = videoKey({ platform: "bilibili", videoId: SECOND_ID });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const seconds = (ms) => `${(ms / 1000).toFixed(1)} 秒`;

async function until(label, read, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`等不到：${label}${lastError ? `（${lastError.message}）` : ""}`);
    await sleep(200);
  }
}

/** 等的途中出了不可挽回的事（worker 被回收），直接失败，不再等。 */
const fatal = (message) => Object.assign(new Error(message), { fatal: true });

/** 用真实的设置读写算出存储里该有的样子：选好服务商、填好密钥、同意数据说明、确认启用。脚本里不手写键名和形状。 */
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

const executable = process.env.CHROME_PATH;
if (!executable) throw new Error("用 CHROME_PATH 指定 Chrome for Testing 的可执行文件");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "jianmu-lifecycle-"));
const extensionDir = join(work, "extension");
prepareExtension({ zip: join(ROOT, "dist", `jianmu-${version}.zip`), dir: extensionDir, origins: [ANTHROPIC.origin, OPENAI.origin] });

const mock = await startMockServer({ dir: work });
const { models } = mock;
const browser = launchChrome({ executable, profileDir: join(work, "profile"), hostRules: mock.hostRules });
const { cdp } = browser;
const hardStop = setTimeout(() => {
  console.error(`✗ 超过 ${seconds(HARD_TIMEOUT_MS)} 仍未结束`);
  browser.child.kill("SIGKILL");
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardStop.unref();

// 只发现、不附加：targetId → { type, url }，worker 被终止或回收时它的目标随之销毁。
const targets = new Map();
const destroyed = new Set();
let workerUrl = "";
/** worker 的目标销毁的时刻：被回收、被终止都算。 */
const workerGone = [];
const pageSessions = new Set();
const errors = [];

cdp.on(({ method, params, sessionId }) => {
  if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") targets.set(params.targetInfo.targetId, params.targetInfo);
  if (method === "Target.targetDestroyed") {
    const info = targets.get(params.targetId);
    if (info?.type === "service_worker" && info.url === workerUrl) workerGone.push(Date.now());
    targets.delete(params.targetId);
    destroyed.add(params.targetId);
  }
  if (!pageSessions.has(sessionId)) return;
  if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push(params.args.map((arg) => arg.value ?? arg.description).join(" "));
});

const findWorker = () => [...targets.values()].find((info) => info.type === "service_worker" && info.url === workerUrl);
const goneSince = (at) => workerGone.some((time) => time >= at);

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, page.sessionId);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

/** 新开一个侧边栏页面（自己占一个标签页时按路径算侧边栏），用它给后台发消息。 */
async function openPage(extensionId) {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/${PAGE_PATHS.sidepanel}` });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  pageSessions.add(sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  const page = { targetId, sessionId };
  await until("扩展页面的脚本就绪", () => evaluate(page, `typeof chrome?.runtime?.sendMessage === "function"`));
  await evaluate(page, `(globalThis.seen = [], globalThis.done = {}, chrome.runtime.onMessage.addListener((message) => void globalThis.seen.push(message)), true)`);
  return page;
}

async function closePage(page) {
  pageSessions.delete(page.sessionId);
  await cdp.send("Target.closeTarget", { targetId: page.targetId });
  await until("页面关掉", () => destroyed.has(page.targetId));
}

/** 从页面给后台发一条消息，等它回复。 */
const ask = (page, type, req = {}) => evaluate(page, `chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);

async function listed(page) {
  const reply = await ask(page, "task.list");
  if (!reply?.ok) throw new Error(`读任务表失败：${JSON.stringify(reply)}`);
  return reply.value.tasks;
}

async function registered(page, video) {
  const reply = await ask(page, "task.start", { kind: "overview", video });
  if (!reply?.ok || reply.value.joined) throw new Error(`登记任务失败：${JSON.stringify(reply)}`);
  return reply.value.task;
}

/** 像侧边栏那样登记概览任务再开始生成，不等回复：回复记在页面的 done[label] 里，页面关了就没人收。 */
function startOverview(page, label, video, extra = {}) {
  const task = JSON.stringify({ type: "task.start", req: { kind: "overview", video } });
  return evaluate(page, `(chrome.runtime.sendMessage(${task})
    .then((started) => started?.ok ? chrome.runtime.sendMessage({ type: "overview.start", req: { video: ${JSON.stringify(video)}, taskId: started.value.task.id, ...${JSON.stringify(extra)} } }) : started)
    .then((reply) => { globalThis.done[${JSON.stringify(label)}] = reply; }, (error) => { globalThis.done[${JSON.stringify(label)}] = { error: String(error) }; }), true)`);
}

const doneOf = (page, label) => evaluate(page, `globalThis.done[${JSON.stringify(label)}] ?? null`);

/** 本机存着的概览：章节数和结论。 */
async function saved(page, video) {
  const reply = await ask(page, "overview.get", { video });
  if (!reply?.ok) throw new Error(`读概览失败：${JSON.stringify(reply)}`);
  const analysis = reply.value.overview?.analysis;
  return { chapters: analysis?.chapters?.length ?? 0, verdict: analysis?.verdict?.summary ?? "" };
}

/** 换一家模型服务：写进存储的是真实设置读写算出来的，再核对后台认为配置可用。 */
async function useService(page, service) {
  const { local, session } = await storedSettings(service);
  await evaluate(page, `Promise.all([chrome.storage.local.set(${JSON.stringify(local)}), chrome.storage.session.set(${JSON.stringify(session)})]).then(() => true)`);
  const check = await ask(page, "config.check");
  if (!check?.ok || check.value.ready !== true) throw new Error(`模型服务的配置不可用：${JSON.stringify(check)}`);
}

const modelCalls = (video, kind) => models.calls.filter((call) => call.video === video && (kind === undefined || call.kind === kind));
const answered = (video, kind) => modelCalls(video, kind).some((call) => call.answeredAt !== undefined);

/** 像 Chrome 自己回收那样终止 worker：全局变量（任务表、计时器、在途请求）全部丢掉。 */
async function killWorker() {
  const worker = findWorker();
  if (!worker) throw new Error("找不到要终止的 service worker");
  const killedAt = Date.now();
  await cdp.send("Target.closeTarget", { targetId: worker.targetId });
  await until("service worker 被终止", () => destroyed.has(worker.targetId));
  return killedAt;
}

let failed = false;
try {
  const { product } = await cdp.send("Browser.getVersion", {}, undefined, STEP_TIMEOUT_MS);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionDir }, undefined, STEP_TIMEOUT_MS);
  workerUrl = `chrome-extension://${id}/background.js`;
  await until("service worker 启动", findWorker);
  console.log(`✓ ${product} 装上了扩展，只附加扩展页面、不附加 service worker`);

  let page = await openPage(id);
  const confirmed = await ask(page, "activation.confirm");
  if (!confirmed?.ok || confirmed.value.state !== "current") throw new Error(`确认启用失败：${JSON.stringify(confirmed)}`);
  console.log("✓ 从侧边栏页面确认了启用");

  // ---- 任务表：认领时限、终止后不恢复 ----
  const phantom = await registered(page, FIRST);
  const registeredAt = Date.now();
  if (!(await listed(page)).some((task) => task.id === phantom.id)) throw new Error("登记的任务不在任务表里");
  await until("没人认领的任务收尾", async () => !(await listed(page)).some((task) => task.id === phantom.id), CLAIM_LATEST_MS + 5000);
  const elapsed = Date.now() - registeredAt;
  if (elapsed < CLAIM_MS - 1000 || elapsed > CLAIM_LATEST_MS) throw new Error(`收尾用了 ${seconds(elapsed)}，认领时限是 ${seconds(CLAIM_MS)}`);
  const ended = await evaluate(page, `globalThis.seen.filter((message) => message.type === "task.changed" && message.task.id === ${JSON.stringify(phantom.id)}).at(-1)?.task.state`);
  if (ended !== "canceled") throw new Error(`收尾时广播的状态是 ${ended}，应为已取消`);
  console.log(`✓ 登记后没人认领的任务过了 ${seconds(elapsed)}按取消收尾`);

  const pending = await registered(page, FIRST);
  if (!(await listed(page)).some((task) => task.id === pending.id)) throw new Error("第二个任务不在任务表里");
  const first = findWorker();
  await killWorker();
  if ((await listed(page)).length !== 0) throw new Error("唤醒后任务表不是空的");
  await until("唤醒了新的 service worker", () => {
    const next = findWorker();
    return next && next.targetId !== first?.targetId;
  });
  await sleep(NO_RESEND_WINDOW_MS);
  if ((await listed(page)).length !== 0) throw new Error("唤醒后任务表里又冒出了任务");
  if (mock.requests.length > 0) throw new Error(`还没开始读取，模拟服务器就收到了请求：${JSON.stringify(mock.requests)}`);
  console.log("✓ 强行终止 service worker 后再唤醒，任务表是空的，没有恢复，模拟服务器一个请求都没收到");

  // ---- 准备：登录模拟的 B 站，配好第一家模型服务 ----
  const { targetId: loginTab } = await cdp.send("Target.createTarget", { url: PROBE.login });
  const { sessionId: loginSession } = await cdp.send("Target.attachToTarget", { targetId: loginTab, flatten: true });
  await until("模拟登录页打开", () => evaluate({ sessionId: loginSession }, `document.readyState === "complete" && document.title === "login"`));
  await cdp.send("Target.closeTarget", { targetId: loginTab });
  await useService(page, ANTHROPIC);
  console.log("✓ 登录了模拟的 B 站，模型服务换成模拟的 Anthropic");

  // ---- 模型请求挂着时关掉发起页面 ----
  models.hold(FIRST_ID);
  await startOverview(page, "hang", FIRST);
  await until("概览请求挂到模拟服务上", () => models.held(FIRST_ID) === 1);
  const hangClosedAt = Date.now();
  await closePage(page);
  await until(
    `关掉页面 ${seconds(PAST_IDLE_MS)} 以后 worker 仍在、挂着的请求没被中止`,
    () => {
      if (goneSince(hangClosedAt)) throw fatal(`关掉页面 ${seconds(Date.now() - hangClosedAt)} 后 service worker 被回收了，挂着的概览请求还没回来`);
      if (modelCalls(FIRST_ID, "analysis").some((call) => call.aborted)) throw fatal("挂着的概览请求被中止了");
      return Date.now() - hangClosedAt > PAST_IDLE_MS;
    },
    PAST_IDLE_MS + 10_000,
  );
  models.release(FIRST_ID);
  await until("概览和结论两次请求都回来", () => {
    if (goneSince(hangClosedAt)) throw fatal("任务跑完之前 service worker 被回收了");
    return answered(FIRST_ID, "analysis") && answered(FIRST_ID, "verdict");
  });
  page = await openPage(id);
  const hung = await until("概览和结论存进本机、任务表收空", async () => {
    const stored = await saved(page, FIRST);
    return stored.chapters > 0 && stored.verdict && (await listed(page)).length === 0 && stored;
  });
  console.log(`✓ 模型请求挂过 ${seconds(PAST_IDLE_MS)}，worker 一直在；回来后任务跑完，存下 ${hung.chapters} 章和结论「${hung.verdict}」`);

  // ---- 读取很慢、没有模型请求的一段里关掉发起页面 ----
  await useService(page, OPENAI);
  mock.setScenario("slow", { delayMs: SLOW_READ_MS });
  const slowFrom = Date.now();
  await startOverview(page, "slow", SECOND);
  await until("开始读视频信息和字幕", () => mock.requests.some((entry) => entry.at >= slowFrom && slowed(entry)));
  const slowClosedAt = Date.now();
  await closePage(page);
  await until(
    "慢读取之后概览和结论两次请求都回来",
    () => {
      if (goneSince(slowClosedAt)) throw fatal(`关掉页面 ${seconds(Date.now() - slowClosedAt)} 后、读取途中 service worker 被回收了`);
      return answered(SECOND_ID, "analysis") && answered(SECOND_ID, "verdict");
    },
    4 * SLOW_READ_MS + PAST_IDLE_MS,
  );
  mock.setScenario("");
  const firstModelCall = Math.min(...modelCalls(SECOND_ID).map((call) => call.at));
  if (firstModelCall - slowClosedAt < PAST_IDLE_MS) throw new Error(`第一次模型请求在关掉页面 ${seconds(firstModelCall - slowClosedAt)} 后就发了，没跨过空闲回收点`);
  page = await openPage(id);
  const slow = await until("慢读取的概览和结论存进本机、任务表收空", async () => {
    const stored = await saved(page, SECOND);
    return stored.chapters > 0 && stored.verdict && (await listed(page)).length === 0 && stored;
  });
  console.log(`✓ 读取拖了 ${seconds(firstModelCall - slowClosedAt)}、这段没有模型请求，worker 一直在；之后换成模拟的 OpenAI 跑完，存下 ${slow.chapters} 章和结论`);

  // ---- 模型请求在途时强行终止 worker ----
  models.hold(FIRST_ID);
  await startOverview(page, "killed", FIRST, { fresh: true });
  await until("重新生成的概览请求挂到模拟服务上", () => models.held(FIRST_ID) === 1);
  const before = modelCalls(FIRST_ID, "analysis").length;
  const killedAt = await killWorker();
  await until("挂着的请求随 worker 断开", () => modelCalls(FIRST_ID, "analysis").at(-1)?.aborted === true);
  if ((await listed(page)).length !== 0) throw new Error("终止后再唤醒，任务表不是空的");
  const waited = Date.now() - killedAt;
  if (waited < NO_RESEND_WINDOW_MS) await sleep(NO_RESEND_WINDOW_MS - waited);
  if (modelCalls(FIRST_ID).filter((call) => call.at > killedAt).length !== 0) throw new Error("终止后自动重发了模型请求");
  if ((await listed(page)).length !== 0) throw new Error("唤醒后任务表里又冒出了任务");
  await startOverview(page, "again", FIRST, { fresh: true });
  await until("再发起的概览请求挂到模拟服务上", () => models.held(FIRST_ID) === 1);
  models.release(FIRST_ID);
  const again = await until("再发起一次能跑完", () => doneOf(page, "again"));
  if (!again.ok) throw new Error(`再发起一次没跑完：${JSON.stringify(again)}`);
  const calls = modelCalls(FIRST_ID, "analysis").slice(before - 1);
  if (calls.length !== 2 || !calls[0].aborted || calls[1].answeredAt === undefined) throw new Error(`模型请求应是一次被中止的、一次回来的：${JSON.stringify(calls)}`);
  console.log(`✓ 模型请求在途时强行终止 worker：挂着的请求断了，任务表是空的，${seconds(NO_RESEND_WINDOW_MS)}内没有重发；再发起一次跑完了`);

  if (errors.length > 0) throw new Error(`扩展页面有报错：\n${errors.join("\n")}`);
  const stray = mock.requests.filter((entry) => entry.unexpected);
  if (stray.length > 0) throw new Error(`模拟服务器收到意外请求：${JSON.stringify(stray)}`);
  console.log(`✓ ${mock.requests.length} 个请求都在模拟路由里，没有意外请求`);
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
