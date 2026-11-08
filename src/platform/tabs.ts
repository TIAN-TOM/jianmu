/// <reference types="chrome" />
// 标签页、侧边栏、设置页和往页面里注入脚本的薄封装。下面的接口只列用到的方法，真实的接口和测试替身都按结构满足它们。

export interface TabsApi {
  query(info: { url: string[] }): Promise<readonly { readonly id?: number }[]>;
  get(tabId: number): Promise<{ readonly title?: string }>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface SidePanelApi {
  open(options: { windowId: number }): Promise<void>;
  setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
}

export interface ScriptInjection {
  readonly target: { readonly tabId: number; readonly allFrames?: boolean };
  readonly files: string[];
}

export interface ScriptingApi {
  executeScript(injection: ScriptInjection): Promise<unknown>;
  insertCSS(injection: ScriptInjection): Promise<unknown>;
}

export interface ManifestPages {
  readonly options_page?: string;
  readonly options_ui?: { readonly page?: string };
  readonly content_scripts?: readonly {
    readonly matches?: readonly string[];
    readonly js?: readonly string[];
    readonly css?: readonly string[];
    readonly all_frames?: boolean;
  }[];
}

/** 清单里声明的一组内容脚本。 */
export interface ContentScript {
  readonly matches: readonly string[];
  readonly js: readonly string[];
  readonly css: readonly string[];
  readonly allFrames: boolean;
}

export interface RuntimePages {
  getManifest(): ManifestPages;
  openOptionsPage(): Promise<void>;
}

export interface TabsDeps {
  readonly tabs: TabsApi;
  readonly sidePanel: SidePanelApi;
  readonly runtime: RuntimePages;
  readonly scripting: ScriptingApi;
}

export interface Tabs {
  /** 清单里内容脚本匹配得上的已开标签页。清单没声明内容脚本时不查。只在确认启用之后调。 */
  readonly contentScriptTabs: () => Promise<readonly number[]>;
  /** 发给一个标签页。标签页正在导航或还没挂监听时浏览器会报错，这是常态，不往外抛。 */
  readonly send: (tabId: number, message: unknown) => Promise<void>;
  /** 打开这个窗口的侧边栏。要在用户手势还有效时同步调用，前面不能有任何等待；被拒绝时是 false。 */
  readonly openSidePanel: (windowId: number) => Promise<boolean>;
  /** 让工具栏图标打开侧边栏。 */
  readonly setPanelBehavior: () => Promise<void>;
  /** 清单里有没有设置页：没有时打开设置页必然失败。 */
  readonly hasOptionsPage: () => boolean;
  readonly openOptionsPage: () => Promise<void>;
  /** 清单里声明的内容脚本，没声明时是空的。 */
  readonly contentScripts: () => readonly ContentScript[];
  /** 地址匹配得上这几条规则的已开标签页。只在确认启用之后调。 */
  readonly tabsMatching: (matches: readonly string[]) => Promise<readonly number[]>;
  /** 往一个标签页补注入一组内容脚本，先样式后脚本。注入不进去时抛错。 */
  readonly inject: (tabId: number, script: ContentScript) => Promise<void>;
  /** 标签页的标题，读不到时是 null。只在确认启用之后调。 */
  readonly title: (tabId: number) => Promise<string | null>;
}

export function createTabs(
  deps: TabsDeps = { tabs: chrome.tabs, sidePanel: chrome.sidePanel, runtime: chrome.runtime, scripting: chrome.scripting },
): Tabs {
  const { tabs, sidePanel, runtime, scripting } = deps;
  async function tabsMatching(matches: readonly string[]): Promise<readonly number[]> {
    if (matches.length === 0) return [];
    const found = await tabs.query({ url: [...matches] });
    return found.flatMap(({ id }) => (typeof id === "number" ? [id] : []));
  }
  return {
    contentScriptTabs: () => tabsMatching((runtime.getManifest().content_scripts ?? []).flatMap(({ matches: list = [] }) => list)),
    send: (tabId, message) => tabs.sendMessage(tabId, message).then(
      () => undefined,
      () => undefined,
    ),
    openSidePanel: (windowId) => sidePanel.open({ windowId }).then(
      () => true,
      () => false,
    ),
    setPanelBehavior: () => sidePanel.setPanelBehavior({ openPanelOnActionClick: true }),
    hasOptionsPage() {
      const { options_page: page, options_ui: ui } = runtime.getManifest();
      return Boolean(page || ui?.page);
    },
    openOptionsPage: () => runtime.openOptionsPage(),
    contentScripts: () =>
      (runtime.getManifest().content_scripts ?? []).map(({ matches = [], js = [], css = [], all_frames: allFrames = false }) => ({
        matches,
        js,
        css,
        allFrames,
      })),
    tabsMatching,
    async title(tabId) {
      try {
        const { title } = await tabs.get(tabId);
        return typeof title === "string" && title.trim() !== "" ? title : null;
      } catch {
        return null;
      }
    },
    async inject(tabId, { js, css, allFrames }) {
      const target = allFrames ? { tabId, allFrames } : { tabId };
      if (css.length > 0) await scripting.insertCSS({ target, files: [...css] });
      if (js.length > 0) await scripting.executeScript({ target, files: [...js] });
    },
  };
}
