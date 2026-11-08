// 补注入：浏览器只给之后打开的页面自动注入内容脚本，安装、更新之后和用户确认启用时，往已经打开的视频页补一次。
// 要按地址查标签页，所以启用确认不算数时什么都不做。脚本文件和匹配规则都从清单里取，这里不写地址。
// 内容脚本自己防重复注入，旧实例发现扩展上下文失效就自己撤掉。
import type { Tabs } from "../platform/tabs.ts";
import { errorLabel, type Log } from "./log.ts";

export interface ReinjectReceipt {
  readonly injected: readonly number[];
  /** 补不上的标签页，侧边栏在这些页面上提示刷新。 */
  readonly failed: readonly number[];
}

export interface ReinjectDeps {
  readonly tabs: Pick<Tabs, "contentScripts" | "tabsMatching" | "inject">;
  /** 首次启用确认算不算数。 */
  readonly enabled: () => Promise<boolean>;
  readonly log: Log;
}

export type Reinject = () => Promise<ReinjectReceipt>;

const NOTHING: ReinjectReceipt = Object.freeze({ injected: [], failed: [] });

export function createReinject({ tabs, enabled, log }: ReinjectDeps): Reinject {
  async function confirmed(): Promise<boolean> {
    try {
      return await enabled();
    } catch (error) {
      log.error("补注入前核对启用状态失败", errorLabel(error));
      return false;
    }
  }

  return async () => {
    const scripts = tabs.contentScripts();
    if (scripts.length === 0 || !(await confirmed())) return NOTHING;
    const injected = new Set<number>();
    const failed = new Set<number>();
    for (const script of scripts) {
      let tabIds: readonly number[];
      try {
        tabIds = await tabs.tabsMatching(script.matches);
      } catch (error) {
        log.error("补注入时查标签页失败", errorLabel(error));
        continue;
      }
      await Promise.all(
        tabIds.map(async (tabId) => {
          try {
            await tabs.inject(tabId, script);
            injected.add(tabId);
          } catch {
            // 页面正在加载、已经关了或者不让注入，都算补不上，交给页面提示刷新。
            failed.add(tabId);
          }
        }),
      );
    }
    if (failed.size > 0) log.warn(`有 ${failed.size} 个已开的视频页补注入失败，要刷新才能用`);
    return { injected: [...injected].filter((tabId) => !failed.has(tabId)), failed: [...failed] };
  };
}
