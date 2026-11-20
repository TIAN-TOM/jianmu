// 启动无头 Chrome：站点主机映射到本机模拟服务器，其余域名都解析失败，扩展连不上外网。
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCdp } from "./cdp.mjs";

/**
 * 把打好的包解压到临时目录。给了 origins 时，只在这份临时副本的清单里加上这几个来源的主机权限：
 * 模型服务的权限要用户在设置页点了才申请，无头 Chrome 里点不了。
 * @param {{ zip: string, dir: string, origins?: readonly string[] }} options
 */
export function prepareExtension({ zip, dir, origins = [] }) {
  execFileSync("unzip", ["-q", zip, "-d", dir]);
  if (!origins.length) return;
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...(manifest.host_permissions ?? []), ...origins.map((origin) => `${origin}/*`)];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// 测试用的浏览器界面语言要是中文，页面测试和端到端照中文断言。Chrome 按平台认：Windows 认 --lang，macOS 认系统的
// -AppleLanguages，Linux 看环境变量 LANGUAGE。Linux 上只设 LANGUAGE，别的环境变量照旧传下去；区域设置（LC_ALL、LC_MESSAGES、LANG）
// 不动：指到机器上没生成的中文区域，系统库会退回 C 区域，带中文的下载文件名就转不成本机编码、落不下来。
const LINUX_CHINESE_ENV = Object.freeze({ LANGUAGE: "zh_CN:zh" });
const UI_LANGUAGE_HINT = "Linux 上设环境变量 LANGUAGE，macOS 上给启动参数 -AppleLanguages (zh-CN)，Windows 上给 --lang=zh-CN（e2e/browser.mjs）";

/**
 * 跑第一条用例之前核对界面语言：在扩展的一个静态资源页里问 chrome.i18n.getUILanguage()，问完关掉这个页面，
 * 不碰 service worker。不是中文就直接报错，免得后面十几条用例按英文界面失败、看不出原因。
 */
export async function assertChineseUi(cdp, extensionId, timeoutMs = 20_000) {
  const { targetId } = await cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/manifest.json` }, undefined, timeoutMs);
  try {
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, undefined, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let language = "";
    for (;;) {
      const { result } = await cdp.send("Runtime.evaluate", { expression: "globalThis.chrome?.i18n?.getUILanguage?.() ?? ''", returnByValue: true }, sessionId, timeoutMs);
      language = String(result.value ?? "");
      if (language || Date.now() > deadline) break;
      await new Promise((done) => setTimeout(done, 50));
    }
    if (!/^zh(?:[-_]|$)/i.test(language)) {
      throw new Error(`测试用的浏览器界面语言不是中文，实际是「${language || "读不到"}」（${process.platform}）。${UI_LANGUAGE_HINT}`);
    }
  } finally {
    await cdp.send("Target.closeTarget", { targetId }, undefined, timeoutMs).catch(() => {});
  }
}

// 调试协议里加载扩展的命令从 Chrome 126 起才有；更老的版本（最低要求 116）改用启动参数加载同一个目录。
const LOAD_COMMAND_SINCE = 126;

function majorVersion(executable) {
  const output = execFileSync(executable, ["--version"], { encoding: "utf8" });
  const major = /\b(\d+)\.\d+\.\d+\.\d+\b/.exec(output)?.[1];
  if (!major) throw new Error(`认不出 Chrome 的版本：${output.trim()}`);
  return Number(major);
}

/**
 * loadExtension() 装上启动时给的 extensionDir，回 { id }，和调试协议命令的回复一个形状。
 * 用启动参数加载时扩展随浏览器启动，loadExtension() 只等它的 service worker 出现。装上以后先核对界面语言（assertChineseUi）。
 */
export function launchChrome({ executable, profileDir, hostRules, extensionDir }) {
  const byFlag = extensionDir !== undefined && majorVersion(executable) < LOAD_COMMAND_SINCE;
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profileDir}`,
      `--host-resolver-rules=${hostRules}`,
      // 走代理时域名交给代理解析，上面的映射就用不上了。
      "--no-proxy-server",
      "--ignore-certificate-errors",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
      // 界面语言固定成中文，各平台认的不一样，见 UI_LANGUAGE_HINT。还没写设置的页面跟着它走；存进去的设置另外写明中文，见 settings.mjs。
      // macOS 上 Chrome 把 (zh-CN) 也当成一个要打开的地址，无头模式只许一个，所以那边不再给 about:blank。
      "--lang=zh-CN",
      ...(byFlag ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] : []),
      ...(process.platform === "darwin" ? ["-AppleLanguages", "(zh-CN)"] : ["about:blank"]),
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env, ...(process.platform === "linux" ? LINUX_CHINESE_ENV : {}) } },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // 测试脚本出意外退出时，别把无头 Chrome 留在后台。
  process.once("exit", () => child.kill("SIGKILL"));
  const cdp = createCdp(child.stdio[3], child.stdio[4]);

  async function loadExtension(timeoutMs = 20_000) {
    if (extensionDir === undefined) throw new Error("启动时没给 extensionDir");
    if (!byFlag) {
      const loaded = await cdp.send("Extensions.loadUnpacked", { path: extensionDir }, undefined, timeoutMs);
      await assertChineseUi(cdp, loaded.id, timeoutMs);
      return loaded;
    }
    const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
    const worker = manifest.background.service_worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const workerUrl = new RegExp(`^chrome-extension://([a-p]{32})/${worker}$`);
    const identity = JSON.stringify([manifest.name, manifest.version]);
    const checked = new Set();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      for (const info of targetInfos) {
        const id = info.type === "service_worker" ? workerUrl.exec(info.url)?.[1] : undefined;
        if (!id || checked.has(id)) continue;
        // 浏览器自带的扩展也可能用同名的 worker 文件，进去核对清单的名字和版本。没核对成的下一轮再试。
        try {
          const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: info.targetId, flatten: true });
          const { result } = await cdp.send(
            "Runtime.evaluate",
            { expression: "JSON.stringify([chrome.runtime.getManifest().name, chrome.runtime.getManifest().version])", returnByValue: true },
            sessionId,
          );
          if (result.value === identity) {
            await assertChineseUi(cdp, id, timeoutMs);
            return { id };
          }
          checked.add(id);
        } catch {}
      }
      if (Date.now() > deadline) throw new Error(`启动参数加载的扩展 ${timeoutMs} 毫秒内没起来`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  return { child, cdp, stderr: () => stderr, loadExtension };
}
