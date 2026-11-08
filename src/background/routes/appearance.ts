// 外观：内容脚本读不到存储，外观和卡片开关经这里读；设置里这两项变了，广播给确认启用之后的内容脚本。
import { ok } from "../../core/errors.ts";
import type { SettingsStore } from "../../platform/settings-store.ts";
import type { Broadcast } from "../../shared/messages.ts";
import { SETTINGS_STORAGE_KEY } from "../../shared/names.ts";
import { activationStatus, normalize } from "../../shared/settings-schema.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

export interface AppearanceRouteDeps {
  readonly settings: Pick<SettingsStore, "loadPublic">;
}

type AppearanceRoutes = { readonly [K in "appearance.get"]: Route<K> };

export function appearanceRoutes({ settings }: AppearanceRouteDeps): AppearanceRoutes {
  return {
    "appearance.get": {
      senders: ["panel", "page", "content:bilibili", "content:youtube"],
      pages: ["options", "triage"],
      beforeEnable: true,
      idempotent: true,
      validate: isEmptyRequest,
      async handler() {
        // 只读不含密钥的那份，回复里只放这两项。
        const { accentTheme, inPageCard } = await settings.loadPublic();
        return ok({ accentTheme, inPageCard });
      },
    },
  };
}

export interface StorageChange {
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
}

/**
 * 设置里外观或卡片开关变了时要发给内容脚本的广播。只看存储事件本身带的新旧值，不另读存储；
 * 变化之后还没确认启用就不发，调用方也就不必去查标签页。
 */
export function appearanceChange(changes: Readonly<Record<string, StorageChange>>, area: string): Broadcast | null {
  if (area !== "local") return null;
  const change = changes[SETTINGS_STORAGE_KEY];
  if (!change) return null;
  const before = normalize(change.oldValue);
  const after = normalize(change.newValue);
  if (before.accentTheme === after.accentTheme && before.inPageCard === after.inPageCard) return null;
  if (activationStatus(after).state !== "current") return null;
  return { type: "appearance.changed", accentTheme: after.accentTheme, inPageCard: after.inPageCard };
}
