// 打开设置页和侧边栏，确认前也放行：没确认时打开的侧边栏和设置页只显示启用说明。卡片问自己所在的窗口里侧边栏开没开。
import { fail, ok } from "../../core/errors.ts";
import type { Messenger } from "../../platform/messaging.ts";
import type { Tabs } from "../../platform/tabs.ts";
import { isOptionsSection, type OptionsOpenRequest } from "../../shared/messages/core.ts";
import type { OpenPanels } from "../open-panels.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

export interface PageRouteDeps {
  readonly tabs: Pick<Tabs, "hasOptionsPage" | "openOptionsPage" | "openOptionsAt">;
  readonly messenger: Messenger;
  readonly panels: Pick<OpenPanels, "isOpen">;
}

type PageRoutes = { readonly [K in "options.open" | "panel.open" | "panel.state"]: Route<K> };

/** 空对象，或者只带一个白名单里的节名。 */
function isOptionsOpenRequest(req: unknown): req is OptionsOpenRequest {
  if (isEmptyRequest(req)) return true;
  if (typeof req !== "object" || req === null || Array.isArray(req)) return false;
  const keys = Object.keys(req);
  return keys.length === 1 && keys[0] === "section" && isOptionsSection((req as { section?: unknown }).section);
}

export function pageRoutes({ tabs, messenger, panels }: PageRouteDeps): PageRoutes {
  return {
    "options.open": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      beforeEnable: true,
      validate: isOptionsOpenRequest,
      async handler(req) {
        // 清单里还没有设置页时，打开必然失败，不去调。
        if (!tabs.hasOptionsPage()) return fail("FORBIDDEN");
        // 带节名时自己打开或切过去：浏览器默认的打开方式只会停在原来的位置。
        if ("section" in req) await tabs.openOptionsAt(req.section);
        else await tabs.openOptionsPage();
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
    "panel.state": {
      senders: ["card"],
      idempotent: true,
      validate: isEmptyRequest,
      async handler(_req, { sender }) {
        if (sender.windowId === undefined) return fail("FORBIDDEN");
        return ok({ open: await panels.isOpen(sender.windowId) });
      },
    },
  };
}
