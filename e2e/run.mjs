// 端到端冒烟：把 zip 解压出来的扩展装进断网的 Chrome for Testing，核对后台和侧边栏都没有报错。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./browser.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 20_000;

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
const work = mkdtempSync(join(tmpdir(), "jianmu-e2e-"));
const extensionDir = join(work, "extension");
execFileSync("unzip", ["-q", join(ROOT, "dist", `jianmu-${version}.zip`), "-d", extensionDir]);

const browser = launchChrome({ executable, profileDir: join(work, "profile") });
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

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(`页面脚本出错：${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return result.value;
}

let failed = false;
try {
  const { product } = await cdp.send("Browser.getVersion", {}, undefined, TIMEOUT_MS);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: extensionDir }, undefined, TIMEOUT_MS);
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

  // 启动期的报错可能晚一点才到，等一小会再查。
  await new Promise((done) => setTimeout(done, 500));
  if (errors.length > 0) throw new Error(`扩展有报错：\n${errors.join("\n")}`);
  console.log("✓ 没有报错");
} catch (error) {
  failed = true;
  console.error(`✗ ${error.message}`);
  // 无头模式的显示日志没有用，只会盖住真正的错误。
  const stderr = browser.stderr().split("\n").filter((line) => line && !line.includes("cv_display_link")).join("\n");
  if (stderr) console.error(`Chrome 的输出：\n${stderr.slice(-2000)}`);
} finally {
  browser.child.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
