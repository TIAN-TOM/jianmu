// 启动无头 Chrome：站点主机映射到本机模拟服务器，其余域名都解析失败，扩展连不上外网。
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCdp } from "./cdp.mjs";

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
 * 用启动参数加载时扩展随浏览器启动，loadExtension() 只等它的 service worker 出现。
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
      ...(byFlag ? [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
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
    if (!byFlag) return cdp.send("Extensions.loadUnpacked", { path: extensionDir }, undefined, timeoutMs);
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
          if (result.value === identity) return { id };
          checked.add(id);
        } catch {}
      }
      if (Date.now() > deadline) throw new Error(`启动参数加载的扩展 ${timeoutMs} 毫秒内没起来`);
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  return { child, cdp, stderr: () => stderr, loadExtension };
}
