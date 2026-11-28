/// <reference types="chrome" />
// 粗筛页入口：先核对后台是不是同一次构建，再接上启用状态和外观，渲染页面。设置页清除本机数据时回到还没读取的样子。
import { effect } from "@preact/signals";
import { render } from "preact";
import { parseVideoKey } from "../../core/video-ref.ts";
import { PAGE_PATHS } from "../../shared/names.ts";
import { siteRules } from "../../sites/rules.ts";
import { createActivation } from "../shared/activation.ts";
import { createPageApi } from "../shared/api.ts";
import { startWhenCurrent } from "../shared/build-check.ts";
import { downloadFile } from "../shared/download.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { renderStaleBackground } from "../shared/ui/stale-background.tsx";
import { bindDocumentLang, initUiLang, uiLang } from "../shared/ui-lang.ts";
import { App } from "./app.tsx";
import { createTriageState } from "./state.ts";
import { triageTextOf } from "./text.ts";

const rules = siteRules.bilibili;

function videoUrl(key: string): string {
  const ref = parseVideoKey(key);
  return ref && rules ? rules.canonicalUrl(ref) : "";
}

// 导出时视频地址的前缀：拿列表里第一个视频的地址，去掉视频号。
function videoBase(key: string): string {
  const ref = parseVideoKey(key);
  const url = videoUrl(key);
  return ref && url.includes(ref.videoId) ? url.slice(0, url.lastIndexOf(ref.videoId)) : "";
}

function download(filename: string, text: string): void {
  downloadFile(filename, [text], "text/markdown;charset=utf-8");
}

// 第一帧就是对的语言；读回设置以后由外观那边纠正，<html lang> 和标题跟着换。
initUiLang();
bindDocumentLang(document, (lang) => triageTextOf(lang).title);

const api = createPageApi();
const root = document.getElementById("app");

function start(): void {
  const activation = createActivation({ api });
  const state = createTriageState({ api, videoBase, videoUrl: (item) => videoUrl(item.videoKey), download, lang: () => uiLang.value });

  void activation.load();
  void watchAppearance(pageAppearanceSources(api), document.documentElement);
  // 启用以后才读粗筛的结果；启用失效时页面只剩说明。
  let loaded = false;
  effect(() => {
    if (!activation.enabled.value) {
      loaded = false;
      return;
    }
    if (loaded) return;
    loaded = true;
    void state.load();
  });
  api.on("data.cleared", () => state.cleared());
  window.addEventListener("pagehide", () => state.dispose());

  if (root) render(<App state={state} activation={activation} optionsUrl={chrome.runtime.getURL(PAGE_PATHS.options)} />, root);
}

void startWhenCurrent(api, start, () => root && renderStaleBackground(root));
