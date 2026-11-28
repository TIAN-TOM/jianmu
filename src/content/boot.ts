/// <reference types="chrome" />
// 两个站的内容脚本入口共用的启动：撤下同一页面上旧的一份，建运行时和本站的页面对象，接上界面、可见性、顶替和媒体加载，登记以后启动。
// 同一页面再注入一份时（安装、更新或确认启用后的补注入），新的一份把旧的整套撤下再接手：
// 同一个扩展上下文里的旧一份靠全局变量找，扩展重新加载以前的旧一份靠页面事件叫（见 app.ts 的 Superseded）。
import { INJECTED, PAGE_PATHS } from "../shared/names.ts";
import type { SitePage } from "../sites/page-types.ts";
import { createContentApp, pageSuperseded, type ContentApp, type ContentAppDeps } from "./app.ts";
import { createBrowserFrameTool } from "./frame.ts";
import { createContentRuntime } from "./runtime.ts";
import { createSurface, type SurfaceDeps } from "./surface.ts";

/** 各站入口在页面对象上给出的：本站的小窗配置和钩子。 */
export type SiteParts = Pick<ContentAppDeps, "site" | "siteReader" | "onHeld" | "onRevoked"> & Pick<SurfaceDeps, "miniPlayer" | "shadowRootOf">;

type Registry = { [INJECTED.instance]?: ContentApp };

/** 先撤下登记着的旧一份，再建新的、登记、启动。 */
export function replaceInstance(registry: Registry, build: () => ContentApp): void {
  registry[INJECTED.instance]?.stop();
  const app = build();
  registry[INJECTED.instance] = app;
  app.start();
}

/** 标签页切回前台时通知。 */
export function pageVisibility(document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">): ContentAppDeps["visibility"] {
  return {
    hidden: () => document.hidden,
    onChange(run) {
      const onVisibility = (): void => {
        if (!document.hidden) run();
      };
      document.addEventListener("visibilitychange", onVisibility);
      return () => document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

/** 媒体事件不冒泡，在捕获阶段听整个文档。 */
export function mediaLoading(document: Pick<Document, "addEventListener" | "removeEventListener">): ContentAppDeps["onMediaLoading"] {
  return (run) => {
    document.addEventListener("loadstart", run, true);
    return () => document.removeEventListener("loadstart", run, true);
  };
}

/** 入口只给本站的页面对象和建在它上面的配置、钩子。 */
export function bootContent<P extends SitePage>(createPage: () => P, partsOf: (page: P) => SiteParts): void {
  replaceInstance(globalThis as Registry, () => {
    const runtime = createContentRuntime(() => (typeof chrome === "undefined" ? undefined : chrome.runtime));
    const page = createPage();
    const { miniPlayer, shadowRootOf, ...hooks } = partsOf(page);
    return createContentApp({
      runtime,
      page,
      ...hooks,
      createSurface: (env) => createSurface({ ...env, document, page, runtime, cardPath: PAGE_PATHS.card, miniPlayer, shadowRootOf }),
      visibility: pageVisibility(document),
      superseded: pageSuperseded(document),
      onMediaLoading: mediaLoading(document),
      // 开关关着的构建里这一支连同截帧代码一起裁掉。
      ...(FEATURE_FRAME_EXPLAIN ? { frame: (identity) => createBrowserFrameTool(document, identity) } : {}),
    });
  });
}
