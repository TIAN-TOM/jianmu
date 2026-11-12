/// <reference types="chrome" />
// B 站播放页的内容脚本入口。同一页面再注入一份时（安装、更新或确认启用后的补注入），新的一份把旧的整套撤下再接手。
import { INJECTED, PAGE_PATHS } from "../shared/names.ts";
import { createBilibiliPage } from "../sites/bilibili/page.ts";
import { createContentApp, type ContentApp } from "./app.ts";
import { createContentRuntime } from "./runtime.ts";
import { createSurface } from "./surface.ts";

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

type Registry = { [INJECTED.instance]?: ContentApp };
const registry = globalThis as Registry;
registry[INJECTED.instance]?.stop();

const runtime = createContentRuntime(() => (typeof chrome === "undefined" ? undefined : chrome.runtime));
const page = createBilibiliPage({ document, location });

const app = createContentApp({
  runtime,
  page,
  createSurface: (env) => createSurface({ ...env, document, page, runtime, cardPath: PAGE_PATHS.card, miniPlayer: MINI_PLAYER, shadowRootOf }),
  visibility: {
    hidden: () => document.hidden,
    onChange(run) {
      const onVisibility = (): void => {
        if (!document.hidden) run();
      };
      document.addEventListener("visibilitychange", onVisibility);
      return () => document.removeEventListener("visibilitychange", onVisibility);
    },
  },
  // 媒体事件不冒泡，在捕获阶段听整个文档。
  onMediaLoading(run) {
    document.addEventListener("loadstart", run, true);
    return () => document.removeEventListener("loadstart", run, true);
  },
});
registry[INJECTED.instance] = app;
app.start();
