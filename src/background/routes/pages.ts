// 打开设置页和侧边栏。确认前也放行：没确认时打开的侧边栏和设置页只显示启用说明。
import { fail, ok } from "../../core/errors.ts";
import type { Messenger } from "../../platform/messaging.ts";
import type { Tabs } from "../../platform/tabs.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

export interface PageRouteDeps {
  readonly tabs: Pick<Tabs, "hasOptionsPage" | "openOptionsPage">;
  readonly messenger: Messenger;
}

type PageRoutes = { readonly [K in "options.open" | "panel.open"]: Route<K> };

export function pageRoutes({ tabs, messenger }: PageRouteDeps): PageRoutes {
  return {
    "options.open": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      beforeEnable: true,
      validate: isEmptyRequest,
      async handler() {
        // 清单里还没有设置页时，打开必然失败，不去调。
        if (!tabs.hasOptionsPage()) return fail("FORBIDDEN");
        await tabs.openOptionsPage();
        return ok({});
      },
    },
    "panel.open": {
      senders: ["page", "card"],
      pages: ["options", "triage"],
      beforeEnable: true,
      gesture: "open-panel",
      validate: isEmptyRequest,
      async handler(_req, { sender, panelOpened }) {
        if ((await panelOpened) !== true) return ok({ opened: false, needsToolbarClick: true });
        // 侧边栏可能本来就开着、停在别的标签页上，让它跟到发起的这个标签页。
        if (sender.tabId !== undefined) await messenger.toPages({ type: "panel.follow", tabId: sender.tabId });
        return ok({ opened: true });
      },
    },
  };
}
