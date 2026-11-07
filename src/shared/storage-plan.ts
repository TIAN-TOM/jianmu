// 每份本机数据放在哪、两种清除怎么处理、进不进备份。清除、备份和测试都只读这张表，
// 新加仓库或键不在这里登记，类型检查直接报错。
import type { ClearScope } from "../core/clear-guard.ts";
import {
  API_KEY_LOCAL_KEY,
  API_KEY_SESSION_KEY,
  APPEARANCE_CACHE_KEY,
  AUTO_LEDGER_KEY,
  CAPABILITY_STORAGE_KEY,
  RELAX_STORAGE_KEY,
  SETTINGS_REVISION_KEY,
  SETTINGS_STORAGE_KEY,
  SITE_BACKOFF_KEY,
  STORAGE_KEYS,
  STORE_NAMES,
  TRIAGE_STORAGE_KEY,
  WATCH_SESSIONS_KEY,
  type StorageKey,
  type StoreName,
} from "./names.ts";

export type StorageArea = "indexeddb" | "local" | "session" | "localStorage";

export interface Plan {
  readonly area: StorageArea;
  readonly clearCache: "keep" | "clear";
  // renew：由后台换成新值，清除时最先写。page-default：后台碰不到 localStorage，各页面收到清除广播后按默认值重写。
  // keep：不是用户资料，清除全部数据也留着。
  readonly clearAll: "clear" | "renew" | "page-default" | "keep";
  readonly backup: boolean;
}

export const STORAGE_PLAN = {
  notes: { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: true },
  overviews: { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: true },
  qa: { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: true },
  translations: { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: false },
  imports: { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: false },
  channels: { area: "indexeddb", clearCache: "keep", clearAll: "clear", backup: false },
  cache: { area: "indexeddb", clearCache: "clear", clearAll: "clear", backup: false },
  [TRIAGE_STORAGE_KEY]: { area: "local", clearCache: "clear", clearAll: "clear", backup: false },
  [CAPABILITY_STORAGE_KEY]: { area: "local", clearCache: "clear", clearAll: "clear", backup: false },
  [RELAX_STORAGE_KEY]: { area: "session", clearCache: "clear", clearAll: "clear", backup: false },
  [SETTINGS_STORAGE_KEY]: { area: "local", clearCache: "keep", clearAll: "clear", backup: false },
  [API_KEY_SESSION_KEY]: { area: "session", clearCache: "keep", clearAll: "clear", backup: false },
  [API_KEY_LOCAL_KEY]: { area: "local", clearCache: "keep", clearAll: "clear", backup: false },
  [WATCH_SESSIONS_KEY]: { area: "session", clearCache: "keep", clearAll: "clear", backup: false },
  [AUTO_LEDGER_KEY]: { area: "session", clearCache: "keep", clearAll: "clear", backup: false },
  [SETTINGS_REVISION_KEY]: { area: "local", clearCache: "keep", clearAll: "renew", backup: false },
  [APPEARANCE_CACHE_KEY]: { area: "localStorage", clearCache: "keep", clearAll: "page-default", backup: false },
  [SITE_BACKOFF_KEY]: { area: "session", clearCache: "keep", clearAll: "keep", backup: false },
} as const satisfies Record<StoreName | StorageKey, Plan>;

export interface ClearTargets {
  readonly stores: readonly StoreName[];
  readonly local: readonly StorageKey[];
  readonly session: readonly StorageKey[];
  readonly renew: readonly StorageKey[]; // 也在 local 里：清除时先换成新值，其余的键再删
}

/** 一次清除后台要动哪些仓库和键。 */
export function clearTargets(scope: ClearScope): ClearTargets {
  const cleared = (plan: Plan): boolean =>
    scope === "cache" ? plan.clearCache === "clear" : plan.clearAll === "clear" || plan.clearAll === "renew";
  const keysIn = (area: StorageArea): StorageKey[] =>
    STORAGE_KEYS.filter((key) => STORAGE_PLAN[key].area === area && cleared(STORAGE_PLAN[key]));
  return {
    stores: STORE_NAMES.filter((name) => cleared(STORAGE_PLAN[name])),
    local: keysIn("local"),
    session: keysIn("session"),
    renew: scope === "all" ? STORAGE_KEYS.filter((key) => STORAGE_PLAN[key].clearAll === "renew") : [],
  };
}
