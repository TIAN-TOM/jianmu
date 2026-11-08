// 模型服务的配置够不够发起请求：启用以后问一次后台，之后设置、会话里的密钥、记住的密钥变了，去抖后再问一次，
// 只换密钥也不用刷新页面。存储变化只看键名，不读新旧值，密钥不经过页面。没启用时不问，回到没启用就清空。
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { Failure } from "../../core/errors.ts";
import type { ConfigCheckView } from "../../shared/messages/ai.ts";
import { API_KEY_LOCAL_KEY, API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY } from "../../shared/names.ts";
import type { PageApi } from "./api.ts";

/** 动了它们就要重问：设置、会话里的密钥、记住密钥的本机记录。 */
export const CONFIG_KEYS: readonly string[] = [SETTINGS_STORAGE_KEY, API_KEY_SESSION_KEY, API_KEY_LOCAL_KEY];

/** 保存设置会接连写几个键，等这么久没有新变化再问。 */
export const CONFIG_DEBOUNCE_MS = 300;

type StorageListener = (changes: object, area: string) => void;

export interface ConfigTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface ConfigDeps {
  readonly api: Pick<PageApi, "send">;
  /** 启用状态；没启用时一条都不问。 */
  readonly enabled: ReadonlySignal<boolean>;
  /** chrome.storage.onChanged。 */
  readonly storageChanged?: { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };
  readonly timers?: ConfigTimers;
}

export type ConfigState =
  | { readonly state: "unknown" }
  | { readonly state: "checked"; readonly view: ConfigCheckView }
  | { readonly state: "failed"; readonly failure: Failure };

export interface ConfigWatch {
  readonly state: ReadonlySignal<ConfigState>;
  /** 马上问一次，比如用户点了重试；没启用时不问。 */
  check(): Promise<void>;
  stop(): void;
}

/** 这次存储变化动没动到配置：只看键名。 */
export function touchesConfig(changes: object): boolean {
  return CONFIG_KEYS.some((key) => Object.hasOwn(changes, key));
}

const UNKNOWN: ConfigState = { state: "unknown" };

const realTimers: ConfigTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createConfigWatch({ api, enabled, storageChanged, timers = realTimers }: ConfigDeps): ConfigWatch {
  const state = signal<ConfigState>(UNKNOWN);
  let generation = 0;
  let pending: unknown = null;
  let stopped = false;

  const cancelPending = (): void => {
    if (pending === null) return;
    timers.clearTimeout(pending);
    pending = null;
  };

  async function check(): Promise<void> {
    cancelPending();
    generation += 1;
    if (stopped || !enabled.peek()) return;
    const asked = generation;
    const reply = await api.send("config.check", {});
    // 问的途中又变了、又问了一次，或者不再启用：这次的回答作废。
    if (stopped || asked !== generation || !enabled.peek()) return;
    state.value = reply.ok ? { state: "checked", view: reply.value } : { state: "failed", failure: reply };
  }

  const onStorage: StorageListener = (changes) => {
    if (stopped || !enabled.peek() || !touchesConfig(changes)) return;
    cancelPending();
    pending = timers.setTimeout(() => {
      pending = null;
      void check();
    }, CONFIG_DEBOUNCE_MS);
  };
  storageChanged?.addListener(onStorage);

  const disposeEffect = effect(() => {
    if (enabled.value) {
      void check();
      return;
    }
    cancelPending();
    generation += 1;
    state.value = UNKNOWN;
  });

  return {
    state,
    check,
    stop() {
      stopped = true;
      cancelPending();
      disposeEffect();
      storageChanged?.removeListener(onStorage);
    },
  };
}
