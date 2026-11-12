/// <reference types="chrome" />
// 粗筛页入口：接上消息客户端、启用状态和外观，渲染页面。设置页清除本机数据时回到还没读取的样子。
import { effect } from "@preact/signals";
import { render } from "preact";
import { parseVideoKey } from "../../core/video-ref.ts";
import { PAGE_PATHS } from "../../shared/names.ts";
import { siteRules } from "../../sites/rules.ts";
import { createActivation } from "../shared/activation.ts";
import { createPageApi } from "../shared/api.ts";
import { pageAppearanceSources, watchAppearance } from "../shared/theme.ts";
import { App } from "./app.tsx";
import { createTriageState } from "./state.ts";

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
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // 浏览器拿到地址就开始下载，稍后再收回。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const api = createPageApi();
const activation = createActivation({ api });
const state = createTriageState({ api, videoBase, videoUrl: (item) => videoUrl(item.videoKey), download });

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

const root = document.getElementById("app");
if (root) render(<App state={state} activation={activation} optionsUrl={chrome.runtime.getURL(PAGE_PATHS.options)} />, root);
