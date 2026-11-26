// 模型服务的配置够不够发起请求：启用以后问一次后台，之后设置、会话里的密钥、记住的密钥变了，去抖后再问一次，
// 只换密钥也不用刷新页面。存储变化只看键名，不读新旧值，密钥不经过页面。没启用时不问，回到没启用就清空。
import { effect, signal, type ReadonlySignal } from "@preact/signals";
import type { Failure } from "../../core/errors.ts";
import type { ConfigCheckView } from "../../shared/messages/ai.ts";
import { API_KEY_LOCAL_KEY, API_KEY_SESSION_KEY, SETTINGS_STORAGE_KEY } from "../../shared/names.ts";
import type { PageApi } from "./api.ts";
import { sharedTextOf } from "./text.ts";
import type { UiLang } from "./ui-lang.ts";

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

/** 没设置好时缺的是什么：只认得出缺密钥和缺同意两种，其余按从没配过说。 */
const missingOf = (state: ConfigState): ConfigCheckView["missing"] => (state.state === "checked" && !state.view.ready ? state.view.missing : undefined);

type MissingWords = { readonly key: string; readonly consent: string; readonly none: string };

const pick = (words: MissingWords, missing: ConfigCheckView["missing"]): string => (missing === "key" ? words.key : missing === "consent" ? words.consent : words.none);

/** 侧边栏头部下面那行提示。只在检查过、没设置好时显示。 */
export function setupNotice(state: ConfigState, lang: UiLang = "zh"): string {
  return pick(sharedTextOf(lang).setup.notice, missingOf(state));
}

/** 要用 AI 的按钮点不了的原因；设置好了是 undefined。 */
export function setupReason(state: ConfigState, lang: UiLang = "zh"): string | undefined {
  if (state.state === "checked" && state.view.ready) return undefined;
  return pick(sharedTextOf(lang).setup.reason, missingOf(state));
}

/** 检查过、确实没设置好：要用 AI 的按钮这时换成去设置页的出口，或者先不摆。还没问到、问失败了都不算。 */
export function needsSetup(state: ConfigState): boolean {
  return state.state === "checked" && !state.view.ready;
}

/** 没设置好时摆在「生成概览」位置上的按钮写什么：缺密钥、缺同意各说各的，其余说去设置 AI 服务。 */
export function setupAction(state: ConfigState, lang: UiLang = "zh"): string {
  return pick(sharedTextOf(lang).setup.action, missingOf(state));
}

/** 卡片上生成概览按钮旁的说明。 */
export function cardSetupHint(state: ConfigState, lang: UiLang = "zh"): string {
  return pick(sharedTextOf(lang).setup.card, missingOf(state));
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
