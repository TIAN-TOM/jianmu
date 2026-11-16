/// <reference types="chrome" />
// 侧边栏入口：建消息客户端，先核对后台是不是同一次构建，再接上外观，拼好各块数据渲染。页面关掉时监听和长连接随页面一起没了，不另外收拾：
// 收到 pagehide 不等于页面真的没了，提前撤掉监听，页面还在时就再也不跟着标签页走。
import { render } from "preact";
import { createPageApi } from "../shared/api.ts";
import { startWhenCurrent } from "../shared/build-check.ts";
import { requestPersistence } from "../shared/persist.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { renderStaleBackground } from "../shared/ui/stale-background.tsx";
import { App } from "./app.tsx";
import { createPanel } from "./panel.ts";

const api = createPageApi();
const root = document.getElementById("app");

function start(): void {
  void watchAppearance(pageAppearanceSources(api), document.documentElement);
  void requestPersistence();
  const panel = createPanel(api, chrome.storage.onChanged);
  if (root) render(<App panel={panel} />, root);
}

void startWhenCurrent(api, start, () => root && renderStaleBackground(root));
