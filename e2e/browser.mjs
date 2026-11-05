// 启动断网的无头 Chrome：所有域名都解析失败，扩展连不上外网。
import { spawn } from "node:child_process";
import { createCdp } from "./cdp.mjs";

export function launchChrome({ executable, profileDir }) {
  const child = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging",
      `--user-data-dir=${profileDir}`,
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
      "--disable-background-networking",
      "--disable-sync",
      "--use-mock-keychain",
      "--password-store=basic",
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
  return { child, cdp: createCdp(child.stdio[3], child.stdio[4]), stderr: () => stderr };
}
