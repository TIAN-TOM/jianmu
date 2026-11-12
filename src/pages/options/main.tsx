/// <reference types="chrome" />
// 设置页入口：接上消息客户端、启用状态、外观和设置仓库，渲染页面。
import { render } from "preact";
import { createLocks } from "../../platform/locks.ts";
import { createSettingsStore } from "../../platform/settings-store.ts";
import { extensionStorage } from "../../platform/storage.ts";
import { createActivation } from "../shared/activation.ts";
import { createPageApi } from "../shared/api.ts";
import { requestPersistence } from "../shared/persist.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { App } from "./app.tsx";
import { createOptionsState } from "./state.ts";

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // 浏览器拿到地址就开始下载，稍后再收回。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const api = createPageApi();
const activation = createActivation({ api });
const state = createOptionsState({
  store: createSettingsStore({ storage: extensionStorage(), locks: createLocks() }),
  api,
  requestHost: (pattern) => chrome.permissions.request({ origins: [pattern] }),
  download,
  storageChanged: chrome.storage.onChanged,
});

void activation.load();
void state.load();
void watchAppearance(pageAppearanceSources(api), document.documentElement);
void requestPersistence();
// 清除全部数据以后设置回到默认值，表单跟着重新载入。
api.on("data.cleared", ({ scope }) => {
  if (scope === "all") void state.load();
});

const root = document.getElementById("app");
if (root) render(<App state={state} activation={activation} />, root);
