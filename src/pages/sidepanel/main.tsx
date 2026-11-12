/// <reference types="chrome" />
// 侧边栏入口：建消息客户端，接上外观，拼好各块数据再渲染。页面关掉时撤掉监听、关掉长连接。
import { render } from "preact";
import { createPageApi } from "../shared/api.ts";
import { requestPersistence } from "../shared/persist.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { App } from "./app.tsx";
import { createPanel } from "./panel.ts";

const api = createPageApi();
void watchAppearance(pageAppearanceSources(api), document.documentElement);
void requestPersistence();
const panel = createPanel(api, chrome.storage.onChanged);
addEventListener("pagehide", () => panel.stop(), { once: true });

const root = document.getElementById("app");
if (root) render(<App panel={panel} />, root);
