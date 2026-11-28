/// <reference types="chrome" />
// B 站播放页的内容脚本入口：建 B 站的页面对象，给出小窗配置和取封闭 shadow root 的办法，其余的启动见 boot.ts。
import { createBilibiliPage } from "../sites/bilibili/page.ts";
import { bootContent } from "./boot.ts";

const MINI_PLAYER = {
  container: () => document.querySelector(".bpx-player-container") ?? document.querySelector("#bilibili-player"),
  closeButton: () => document.querySelector(".bpx-player-mini-close"),
  screenAttribute: "data-screen",
};

// 封闭的 shadow root 只有扩展的这个接口拿得到。
function shadowRootOf(element: Element): ShadowRoot | null {
  try {
    return chrome.dom?.openOrClosedShadowRoot?.(element as HTMLElement) ?? element.shadowRoot;
  } catch {
    return element.shadowRoot;
  }
}

bootContent(() => createBilibiliPage({ document, location }), () => ({ miniPlayer: MINI_PLAYER, shadowRootOf }));
