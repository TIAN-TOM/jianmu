// 页面测试：把 build/ 复制一份、只在副本里加上组件样张，装进断网的 Chrome for Testing，
// 站点主机都指向本机模拟服务器。按文件跑场景，每个测试打开自己的页面，跑完写报告。
//
//   npm run test:pages   先构建再运行；用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
//
// 报告写到 e2e/artifacts/pages-report.json：每个测试的文件、标题、通过与否、耗时，加上提交号和工作区是否干净。
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { launchChrome } from "./browser.mjs";
import { MODEL_HOSTS } from "./mock-ai.mjs";
import { startMockServer } from "./mock-server.mjs";
import { createHarness, registered, STEP_TIMEOUT_MS } from "./pages/harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const REPORT = join(ROOT, "e2e/artifacts/pages-report.json");
// 每个测试的上限：卡住的测试到点判失败，后面的照跑。
const TEST_TIMEOUT_MS = 30_000;
// 扩展页面里晚到的报错等这么久再算。
const SETTLE_MS = 150;

/** 场景文件，按页面分。后面的页面加进来时在这里登记。 */
const SCENARIOS = ["e2e/pages/gallery.mjs", "e2e/pages/sidepanel.mjs", "e2e/pages/triage.mjs", "e2e/pages/options.mjs", "e2e/pages/card.mjs"];

const executable = process.env.CHROME_PATH;
if (!executable) throw new Error("用 CHROME_PATH 指定 Chrome for Testing 的可执行文件");
if (!existsSync(join(BUILD, "manifest.json"))) throw new Error("先跑 npm run build");

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const startedAt = new Date().toISOString();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;

/** 复制构建产物，再把组件样张现编进副本：样张只在测试里有，不进产品包。 */
async function prepareExtension(dir) {
  cpSync(BUILD, dir, { recursive: true });
  // 模型服务的主机权限要用户在设置页点了才申请，无头 Chrome 里点不了授权框：副本的清单里先写上，申请时直接放行。
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...manifest.host_permissions, ...MODEL_HOSTS.map((host) => `https://${host}/*`)];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const fixtures = join(ROOT, "e2e/pages/fixtures");
  for (const name of ["gallery.html", "gallery.css", "card-sample.html"]) cpSync(join(fixtures, name), join(dir, "pages", name));
  await build({
    absWorkingDir: ROOT,
    entryPoints: { gallery: join(fixtures, "gallery.tsx"), "card-sample": join(fixtures, "card-sample.tsx") },
    outdir: join(dir, "pages"),
    bundle: true,
    format: "esm",
    target: "chrome116",
    jsx: "automatic",
    jsxImportSource: "preact",
    logLevel: "warning",
  });
}

const work = mkdtempSync(join(tmpdir(), "jianmu-pages-"));
const extensionDir = join(work, "extension");
await prepareExtension(extensionDir);
const expectedId = readFileSync(join(ROOT, "tests/fixtures/extension-id.txt"), "utf8").trim();

const mock = await startMockServer({ dir: work });
const browser = launchChrome({ executable, profileDir: join(work, "profile"), hostRules: mock.hostRules, extensionDir });
const { cdp } = browser;
/** @type {Map<string, { type: string, url: string, targetId: string }>} */
const sessions = new Map();
/** @type {{ at: number, text: string }[]} */
const errors = [];

cdp.on(({ method, params, sessionId }) => {
  if (method === "Target.attachedToTarget") {
    sessions.set(params.sessionId, params.targetInfo);
    for (const domain of ["Runtime.enable", "Log.enable"]) cdp.send(domain, {}, params.sessionId).catch(() => {});
    cdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
    return;
  }
  if (method === "Target.detachedFromTarget") {
    sessions.delete(params.sessionId);
    return;
  }
  if (method === "Target.targetInfoChanged") {
    for (const [id, info] of sessions) if (info.targetId === params.targetInfo.targetId) sessions.set(id, params.targetInfo);
    return;
  }
  const origin = sessions.get(sessionId)?.url ?? "";
  if (!origin.startsWith("chrome-extension://")) return;
  const at = Date.now();
  if (method === "Runtime.exceptionThrown") errors.push({ at, text: `${origin}：${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}` });
  if (method === "Runtime.consoleAPICalled" && params.type === "error") errors.push({ at, text: `${origin}：${params.args.map((arg) => arg.value ?? arg.description).join(" ")}` });
  if (method === "Log.entryAdded" && params.entry.level === "error") errors.push({ at, text: `${origin}：${params.entry.text}` });
});

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 超过 ${ms} 毫秒`)), ms).unref())]);

/** @type {{ file: string, title: string, ok: boolean, ms: number, error?: string }[]} */
const results = [];
let chrome = "";
let setupError = null;
try {
  ({ product: chrome } = await cdp.send("Browser.getVersion", {}, undefined, STEP_TIMEOUT_MS));
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  // 设置页导出备份会下载文件：落到临时目录，不进用户的下载文件夹。
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(work, "downloads") });
  const { id } = await browser.loadExtension(STEP_TIMEOUT_MS * 2);
  if (id !== expectedId) throw new Error(`扩展 ID 是 ${id}，应为 ${expectedId}`);
  console.log(`${chrome} 装上了扩展，开始页面测试`);

  for (const file of SCENARIOS) await import(pathToFileURL(join(ROOT, file)).href);
  const harness = createHarness({ cdp, extensionId: id, sessions });
  for (const { file, title, fn } of registered()) {
    const ctx = harness.context();
    const started = Date.now();
    let error = null;
    try {
      await withTimeout(fn(ctx), TEST_TIMEOUT_MS, title);
      await new Promise((done) => setTimeout(done, SETTLE_MS));
      const late = errors.filter((entry) => entry.at >= started).map((entry) => entry.text);
      if (late.length > 0) throw new Error(`扩展页面有报错：\n${late.join("\n")}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      await ctx.close();
    }
    const ms = Date.now() - started;
    results.push({ file, title, ok: error === null, ms, ...(error === null ? {} : { error }) });
    console.log(`${error === null ? "✓" : "✗"} ${title}（${ms} 毫秒）${error === null ? "" : `\n    ${error.replaceAll("\n", "\n    ")}`}`);
  }

  const stray = mock.requests.filter((entry) => entry.unexpected);
  const strayError = stray.length > 0 ? `模拟服务器收到意外请求：${JSON.stringify(stray)}` : null;
  results.push({ file: "e2e/pages.mjs", title: "收尾：模拟服务器没有收到意外请求", ok: strayError === null, ms: 0, ...(strayError ? { error: strayError } : {}) });
  console.log(strayError ? `✗ ${strayError}` : `✓ 收尾：${mock.requests.length} 个请求都在模拟路由里`);
} catch (error) {
  setupError = error instanceof Error ? error.message : String(error);
  console.error(`✗ ${setupError}`);
  const stderr = browser.stderr().split("\n").filter((line) => line && !line.includes("cv_display_link")).join("\n");
  if (stderr) console.error(`Chrome 的输出：\n${stderr.slice(-2000)}`);
} finally {
  browser.child.kill("SIGKILL");
  mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

mkdirSync(dirname(REPORT), { recursive: true });
const report = { kind: "pages", commit, dirty, startedAt, chrome, ...(setupError ? { error: setupError } : {}), tests: results };
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
const failed = results.filter((result) => !result.ok).length;
console.log(`页面测试 ${results.length - failed}/${results.length} 通过，报告在 e2e/artifacts/pages-report.json${dirty ? "（工作区有未提交的改动）" : ""}`);
process.exit(setupError || failed > 0 ? 1 : 0);
