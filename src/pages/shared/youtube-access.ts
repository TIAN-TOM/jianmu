/// <reference types="chrome" />
// 在 YouTube 上启用、停用：启用就是授予 YouTube 站点的访问权限，停用就是收回。授权在后台注册内容脚本，收回后台撤下。
// 只从构建开关的分支引用，开关关着时整个模块不进包。申请授权要用户手势：按钮的点击里第一件事就是申请，前面不能有等待。
import { signal, type ReadonlySignal } from "@preact/signals";
import { siteRules } from "../../sites/rules.ts";

interface PermissionEvent {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
}

/** 用到的 chrome.permissions，测试注入替身。 */
export interface YoutubePermissionsApi {
  contains(permissions: { origins: string[] }): Promise<boolean>;
  request(permissions: { origins: string[] }): Promise<boolean>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
  readonly onAdded: PermissionEvent;
  readonly onRemoved: PermissionEvent;
}

/** 申请的结果：给了、用户没给、这个页面里弹不出授权框。 */
export type EnableOutcome = "granted" | "declined" | "unavailable";

export interface YoutubeAccess {
  /** 还没查到时是 null。 */
  readonly granted: ReadonlySignal<boolean | null>;
  /** 在点击里直接调。 */
  readonly enable: () => Promise<EnableOutcome>;
  readonly disable: () => Promise<boolean>;
  readonly stop: () => void;
}

export function createYoutubeAccess(api: YoutubePermissionsApi = chrome.permissions): YoutubeAccess {
  const origins = [...(siteRules.youtube?.permissionOrigins ?? [])];
  const granted = signal<boolean | null>(null);
  const refresh = (): void => {
    if (origins.length === 0) {
      granted.value = false;
      return;
    }
    api.contains({ origins }).then(
      (value) => (granted.value = value),
      () => (granted.value = false),
    );
  };
  api.onAdded.addListener(refresh);
  api.onRemoved.addListener(refresh);
  refresh();
  return {
    granted,
    async enable() {
      if (origins.length === 0) return "unavailable";
      try {
        const given = await api.request({ origins });
        refresh();
        return given ? "granted" : "declined";
      } catch {
        return "unavailable";
      }
    },
    async disable() {
      try {
        const removed = await api.remove({ origins });
        refresh();
        return removed;
      } catch {
        return false;
      }
    },
    stop() {
      api.onAdded.removeListener(refresh);
      api.onRemoved.removeListener(refresh);
    },
  };
}
