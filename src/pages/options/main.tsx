/// <reference types="chrome" />
// 设置页入口：先核对后台是不是同一次构建，再接上启用状态、外观和设置仓库，渲染页面。
import { render } from "preact";
import { createLocks } from "../../platform/locks.ts";
import { createSettingsStore } from "../../platform/settings-store.ts";
import { extensionStorage } from "../../platform/storage.ts";
import { createActivation } from "../shared/activation.ts";
import { createPageApi } from "../shared/api.ts";
import { startWhenCurrent } from "../shared/build-check.ts";
import { requestPersistence } from "../shared/persist.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { renderStaleBackground } from "../shared/ui/stale-background.tsx";
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
const root = document.getElementById("app");

function start(): void {
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

  if (root) render(<App state={state} activation={activation} />, root);
}

void startWhenCurrent(api, start, () => root && renderStaleBackground(root));
