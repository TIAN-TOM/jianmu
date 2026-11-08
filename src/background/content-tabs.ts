// 发过消息的内容脚本在哪些标签页：只记编号，不记地址，只在内存里。
// 没确认启用时不能按地址查标签页，清除全部数据之后要通知内容脚本，就按这里的编号发。

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
