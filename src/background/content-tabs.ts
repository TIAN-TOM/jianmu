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
