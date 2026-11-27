// 哪些窗口开着侧边栏：浏览器报开了、关了就记进会话存储，再广播给各页面，同一窗口里的卡片据此让位或回来。
// 后台随时会被回收，所以不记在内存里。开关事件是新一些的浏览器才有的；没有时这张表一直是空的，卡片照旧只跟模式走。
// 关闭万一没报上来，只有在一个侧边栏页面都不在时才看得出来（浏览器不说侧边栏页面在哪个窗口）：这时整张表作废并通知各卡片。
import { createSerialQueue } from "../core/concurrency.ts";
import type { StorageArea } from "../platform/storage.ts";
import type { Broadcast } from "../shared/messages.ts";
import { OPEN_PANELS_KEY } from "../shared/names.ts";

export interface OpenPanelsDeps {
  readonly storage: Pick<StorageArea, "get" | "set">;
  /** 这会儿有没有开着的侧边栏页面，不分窗口。 */
  readonly anySidePanel: () => Promise<boolean>;
  readonly broadcast: (message: Broadcast) => void;
}

export interface OpenPanels {
  /** 浏览器报这个窗口的侧边栏开了或关了。 */
  readonly changed: (windowId: number, open: boolean) => Promise<void>;
  readonly isOpen: (windowId: number) => Promise<boolean>;
}

const isWindowId = (value: unknown): value is number => Number.isInteger(value);

export function createOpenPanels({ storage, anySidePanel, broadcast }: OpenPanelsDeps): OpenPanels {
  // 读—改—写排成一队：两个窗口前后脚开关时不互相盖掉。
  const queued = createSerialQueue();

  // 会话存储只有扩展自己读写，读出来仍按不可信处理。
  async function load(): Promise<readonly number[]> {
    const stored = (await storage.get(OPEN_PANELS_KEY))[OPEN_PANELS_KEY];
    return Array.isArray(stored) ? stored.filter(isWindowId) : [];
  }

  return {
    async changed(windowId, open) {
      await queued(async () => {
        const before = await load();
        if (before.includes(windowId) === open) return;
        await storage.set({ [OPEN_PANELS_KEY]: open ? [...before, windowId] : before.filter((id) => id !== windowId) });
      });
      broadcast({ type: "panel.changed", windowId, open });
    },
    async isOpen(windowId) {
      if (!(await load()).includes(windowId)) return false;
      if (await anySidePanel()) return true;
      // 记着开着、实际一个侧边栏页面都不在：关闭那一下没报上来。排进队里重新核对一遍再作废，
      // 免得核对的这一会儿别的窗口刚报了打开，被这次过时的结果抹掉。
      return queued(async () => {
        const now = await load();
        if (now.length === 0) return false;
        if (await anySidePanel()) return now.includes(windowId);
        await storage.set({ [OPEN_PANELS_KEY]: [] });
        for (const id of now) broadcast({ type: "panel.changed", windowId: id, open: false });
        return false;
      });
    },
  };
}
