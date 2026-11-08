// 生命周期冒烟（最小版）：任务表在真实 Chrome 里的两件事。登记了却没人认领的任务按真实计时到点收尾；
// 强行终止 service worker 以后再唤醒，任务表是空的，不恢复、不重发，模拟服务一个请求都没收到。
//
//   npm run test:e2e:lifecycle   打包后运行，约 20 秒；用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
//
// 单独成一个脚本，不放进 run.mjs：那边给 service worker 挂了调试器，挂着调试器 Chrome 就不回收 worker，
// 这里要看它被终止以后的样子。所以只附加扩展页面，从不附加 worker。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { videoKey } from "../src/core/video-ref.ts";
import { PAGE_PATHS } from "../src/shared/names.ts";
import { launchChrome } from "./browser.mjs";
import { VIDEOS } from "./fixtures.mjs";
import { startMockServer } from "./mock-server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_TIMEOUT_MS = 20_000;
const HARD_TIMEOUT_MS = 120_000;
// 后台的认领时限是 15 秒。收尾早于这个时间说明不是按时限收的；晚太多说明计时器没起作用。
const CLAIM_MS = 15_000;
const CLAIM_LATEST_MS = CLAIM_MS + 10_000;
// 终止之后至少看这么久，确认没有谁自动重发。
const NO_RESEND_WINDOW_MS = 3000;
const [VIDEO_ID = ""] = Object.keys(VIDEOS);
const VIDEO = videoKey({ platform: "bilibili", videoId: VIDEO_ID });

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
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`等不到：${label}${lastError ? `（${lastError.message}）` : ""}`);
    await sleep(100);
  }
}

const executable = process.env.CHROME_PATH;
if (!executable) throw new Error("用 CHROME_PATH 指定 Chrome for Testing 的可执行文件");

const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "jianmu-lifecycle-"));
const extensionDir = join(work, "extension");
execFileSync("unzip", ["-q", join(ROOT, "dist", `jianmu-${version}.zip`), "-d", extensionDir]);

const mock = await startMockServer({ dir: work });
const browser = launchChrome({ executable, profileDir: join(work, "profile"), hostRules: mock.hostRules });
const { cdp } = browser;
const hardStop = setTimeout(() => {
  console.error(`✗ 超过 ${seconds(HARD_TIMEOUT_MS)} 仍未结束`);
  browser.child.kill("SIGKILL");
  process.exit(1);
}, HARD_TIMEOUT_MS);
hardStop.unref();

// 只发现、不附加：targetId → { type, url }，worker 被终止时它的目标随之销毁。
const targets = new Map();
const destroyed = new Set();
const errors = [];
let pageSession = "";

cdp.on(({ method, params, sessionId }) => {
  if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") targets.set(params.targetInfo.targetId, params.targetInfo);
  if (method === "Target.targetDestroyed") {
    targets.delete(params.targetId);
    destroyed.add(params.targetId);
  }
  if (!pageSession || sessionId !== pageSession) return;
  if (method === "Runtime.exceptionThrown") errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push(params.args.map((arg) => arg.value ?? arg.description).join(" "));
});

async function evaluate(expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, pageSession);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

/** 从扩展页面给后台发一条消息，等它回复。 */
const ask = (type, req = {}) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ type, req })})`);

async function listed() {
  const reply = await ask("task.list");
  if (!reply?.ok) throw new Error(`读任务表失败：${JSON.stringify(reply)}`);
  return reply.value.tasks;
}

async function started() {
  const reply = await ask("task.start", { kind: "overview", video: VIDEO });
  if (!reply?.ok || reply.value.joined) throw new Error(`登记任务失败：${JSON.stringify(reply)}`);
  return reply.value.task;
}

let failed = false;
try {
  const { product } = await cdp.send("Browser.getVersion", {}, undefined, STEP_TIMEOUT_MS);
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionDir }, undefined, STEP_TIMEOUT_MS);
  const workerUrl = `chrome-extension://${id}/background.js`;
  const findWorker = () => [...targets.values()].find((info) => info.type === "service_worker" && info.url === workerUrl);
  await until("service worker 启动", findWorker);
  console.log(`✓ ${product} 装上了扩展，只附加扩展页面、不附加 service worker`);

  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${id}/${PAGE_PATHS.sidepanel}` });
  ({ sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  await cdp.send("Runtime.enable", {}, pageSession);
  await until("扩展页面的脚本就绪", () => evaluate(`typeof chrome?.runtime?.sendMessage === "function"`));
  await evaluate(`(globalThis.seen = [], chrome.runtime.onMessage.addListener((message) => void globalThis.seen.push(message)), true)`);

  const confirmed = await ask("activation.confirm");
  if (!confirmed?.ok || confirmed.value.state !== "current") throw new Error(`确认启用失败：${JSON.stringify(confirmed)}`);
  console.log("✓ 从侧边栏页面确认了启用");

  const phantom = await started();
  const registeredAt = Date.now();
  if (!(await listed()).some((task) => task.id === phantom.id)) throw new Error("登记的任务不在任务表里");
  await until("没人认领的任务收尾", async () => !(await listed()).some((task) => task.id === phantom.id), CLAIM_LATEST_MS + 5000);
  const elapsed = Date.now() - registeredAt;
  if (elapsed < CLAIM_MS - 1000 || elapsed > CLAIM_LATEST_MS) throw new Error(`收尾用了 ${seconds(elapsed)}，认领时限是 ${seconds(CLAIM_MS)}`);
  const ended = await evaluate(`globalThis.seen.filter((message) => message.type === "task.changed" && message.task.id === ${JSON.stringify(phantom.id)}).at(-1)?.task.state`);
  if (ended !== "canceled") throw new Error(`收尾时广播的状态是 ${ended}，应为已取消`);
  console.log(`✓ 登记后没人认领的任务过了 ${seconds(elapsed)}按取消收尾`);

  const pending = await started();
  if (!(await listed()).some((task) => task.id === pending.id)) throw new Error("第二个任务不在任务表里");
  const worker = findWorker();
  if (!worker) throw new Error("找不到要终止的 service worker");
  // 像 Chrome 自己回收那样终止：全局变量（任务表、计时器）全部丢掉。
  await cdp.send("Target.closeTarget", { targetId: worker.targetId });
  await until("service worker 被终止", () => destroyed.has(worker.targetId));
  const afterWake = await listed();
  if (afterWake.length !== 0) throw new Error(`唤醒后任务表不是空的：${JSON.stringify(afterWake)}`);
  await until("唤醒了新的 service worker", () => {
    const next = findWorker();
    return next && next.targetId !== worker.targetId;
  });
  await sleep(NO_RESEND_WINDOW_MS);
  if ((await listed()).length !== 0) throw new Error("唤醒后任务表里又冒出了任务");
  console.log("✓ 强行终止 service worker 后再唤醒，任务表是空的，没有恢复");

  if (errors.length > 0) throw new Error(`扩展页面有报错：\n${errors.join("\n")}`);
  if (mock.requests.length > 0) throw new Error(`模拟服务器收到了请求：${JSON.stringify(mock.requests)}`);
  console.log("✓ 模拟服务器一个请求都没收到，没有重发");
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
