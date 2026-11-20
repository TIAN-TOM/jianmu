/// <reference types="chrome" />
// 设置页入口：先按首帧缓存同步定下界面语言，再核对后台是不是同一次构建，接上启用状态、外观和设置仓库，渲染页面。
import { render } from "preact";
import { createLocks } from "../../platform/locks.ts";
import { createSettingsStore } from "../../platform/settings-store.ts";
import { extensionStorage } from "../../platform/storage.ts";
import { isOptionsSection } from "../../shared/messages/core.ts";
import { createActivation } from "../shared/activation.ts";
import { createPageApi } from "../shared/api.ts";
import { startWhenCurrent } from "../shared/build-check.ts";
import { requestPersistence } from "../shared/persist.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { bindDocumentLang, initUiLang, uiLang } from "../shared/ui-lang.ts";
import { renderStaleBackground } from "../shared/ui/stale-background.tsx";
import { App } from "./app.tsx";
import { createOptionsState } from "./state.ts";
import { textOf } from "./text.ts";

function download(filename: string, chunks: readonly string[]): void {
  const url = URL.createObjectURL(new Blob([...chunks], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // 浏览器拿到地址就开始下载，稍后再收回。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 等这一节渲染出来，最多等两秒左右；没确认启用时设置页没有这一节，等不到就算了。后台标签页里动画帧不走，所以按定时器等。 */
async function rendered(id: string): Promise<HTMLElement | null> {
  for (let tries = 0; tries < 100; tries += 1) {
    const node = document.getElementById(id);
    if (node) return node;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

/**
 * 从侧边栏、卡片带着节名打开或切过来时，地址里是 #节名。内容是读完设置才渲染的，浏览器自己的定位落空，
 * 这里等那一节出来再滚过去，然后把节名从地址上去掉：下次带同一个节名切过来时地址才算变了。认不出的节名不理。
 */
function followSection(loaded: Promise<unknown>): void {
  const go = async (): Promise<void> => {
    const section = location.hash.slice(1);
    if (!isOptionsSection(section)) return;
    await loaded;
    const target = await rendered(section);
    history.replaceState(null, "", location.pathname + location.search);
    target?.scrollIntoView({ block: "start" });
  };
  void go();
  window.addEventListener("hashchange", () => void go());
}

// 第一帧就是对的语言；读回设置以后由外观那边纠正，<html lang> 和标题跟着换。
initUiLang();
bindDocumentLang(document, (lang) => textOf(lang).title);

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
    lang: () => uiLang.value,
  });

  followSection(Promise.allSettled([activation.load(), state.load()]));
  void watchAppearance(pageAppearanceSources(api), document.documentElement);
  void requestPersistence();
  // 清除全部数据以后设置回到默认值，表单跟着重新载入。
  api.on("data.cleared", ({ scope }) => {
    if (scope === "all") void state.load();
  });

  if (root) render(<App state={state} activation={activation} api={api} version={chrome.runtime.getManifest().version} />, root);
}

void startWhenCurrent(api, start, () => root && renderStaleBackground(root));
