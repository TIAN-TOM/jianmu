// 首次启用：读启用状态、确认启用。确认前也放行，只有侧边栏和设置页能确认；确认之后往已开的视频页补注入一次。
import { ok } from "../../core/errors.ts";
import type { Messenger } from "../../platform/messaging.ts";
import type { SettingsStore } from "../../platform/settings-store.ts";
import { SETTINGS_STORAGE_KEY } from "../../shared/names.ts";
import { activationStatus } from "../../shared/settings-schema.ts";
import type { Reinject } from "../reinject.ts";
import type { Route } from "../router.ts";
import type { StorageChange } from "./appearance.ts";
import { isEmptyRequest } from "./validate.ts";

export interface ActivationRouteDeps {
  readonly settings: Pick<SettingsStore, "activation" | "confirmActivation">;
  readonly messenger: Messenger;
  /** 要通知的内容脚本标签页。只在确认之后取。 */
  readonly contentTargets: () => Promise<readonly number[]>;
  readonly reinject: Reinject;
}

type ActivationRoutes = { readonly [K in "activation.get" | "activation.confirm"]: Route<K> };

export function activationRoutes({ settings, messenger, contentTargets, reinject }: ActivationRouteDeps): ActivationRoutes {
  return {
    "activation.get": {
      senders: ["panel", "page", "content:bilibili", "content:youtube"],
      pages: ["options", "triage"],
      beforeEnable: true,
      idempotent: true,
      validate: isEmptyRequest,
      handler: async () => ok(await settings.activation()),
    },
    "activation.confirm": {
      senders: ["panel", "page"],
      pages: ["options"],
      beforeEnable: true,
      validate: isEmptyRequest,
      async handler() {
        const status = await settings.confirmActivation();
        const message = { type: "activation.changed", confirmed: status.state === "current" } as const;
        await Promise.all([messenger.toPages(message), messenger.toTabs(await contentTargets(), message)]);
        const { failed } = await reinject();
        return ok({ ...status, unreachableTabs: failed });
      },
    },
  };
}

/**
 * 设置变了以后启用确认不再算数（比如清除全部数据连带清掉了确认）：已经连着的业务端口要断开。
 * 只看存储事件本身带的新值，不另读存储。
 */
export function activationLost(changes: Readonly<Record<string, StorageChange>>, area: string): boolean {
  if (area !== "local") return false;
  const change = changes[SETTINGS_STORAGE_KEY];
  return change !== undefined && activationStatus(change.newValue).state !== "current";
}

/**
 * 这次变化把原本算数的启用确认弄没了（比如清除全部数据）：已开视频页里的内容脚本要撤下界面、重新等确认。
 * 从没确认过、原本就过期的不算，那时还不能按地址找标签页，也没有界面要撤。
 */
export function activationDropped(changes: Readonly<Record<string, StorageChange>>, area: string): boolean {
  const change = changes[SETTINGS_STORAGE_KEY];
  return activationLost(changes, area) && change !== undefined && activationStatus(change.oldValue).state === "current";
}
