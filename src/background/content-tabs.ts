// 发过消息的内容脚本在哪些标签页：只记编号，不记地址，只在内存里。
// 没确认启用时不能按地址查标签页，清除全部数据之后要通知内容脚本，就按这里的编号发。

import type { ContentScript, Tabs } from "../platform/tabs.ts";

export interface ContentTabs {
  readonly add: (tabId: number) => void;
  readonly remove: (tabId: number) => void;
  readonly list: () => readonly number[];
}

export function createContentTabs(): ContentTabs {
  const ids = new Set<number>();
  return {
    add: (tabId) => {
      ids.add(tabId);
    },
    remove: (tabId) => {
      ids.delete(tabId);
    },
    list: () => [...ids],
  };
}

/** 按授权动态注册了内容脚本的站（YouTube）的已开页面。只在确认启用之后调；没有这种站、查不到时是空的。 */
export async function siteTabs(tabs: Pick<Tabs, "tabsMatching">, scripts: (() => Promise<readonly ContentScript[]>) | undefined): Promise<readonly number[]> {
  if (!scripts) return [];
  try {
    return await tabs.tabsMatching((await scripts()).flatMap((script) => script.matches));
  } catch {
    return [];
  }
}

export interface ContentTargets {
  /**
   * 要通知的内容脚本所在的标签页：登记过的，加上按清单和已授权站点的匹配规则查到的。每次按地址查之前都核对启用，
   * 不算数（从没确认、清除全部数据以后）就只给登记过的，调用方不用另外核对。通知是尽力而为，查不到时只给登记过的。
   */
  readonly all: () => Promise<readonly number[]>;
}

export function createContentTargets({
  registered,
  tabs,
  siteScripts,
  enabled,
}: {
  readonly registered: Pick<ContentTabs, "list">;
  readonly tabs: Pick<Tabs, "tabsMatching" | "contentScriptTabs">;
  readonly siteScripts: (() => Promise<readonly ContentScript[]>) | undefined;
  readonly enabled: () => Promise<boolean>;
}): ContentTargets {
  const queries = [() => tabs.contentScriptTabs(), () => siteTabs(tabs, siteScripts)];
  return {
    async all() {
      const found = new Set(registered.list());
      // 两次查之间隔着等待：中途启用失效（清除全部数据）就不再按地址查。
      for (const query of queries) {
        if (!(await enabled().catch(() => false))) break;
        for (const tabId of await query().catch(() => [])) found.add(tabId);
      }
      return [...found];
    },
  };
}
