// 打开就出结论的接线：设置、窗口和标签页、本机概览、取字幕和任务登记都从这里交给自动生成服务。
// 自动任务和用户点的「生成概览」登记成同一种任务、取定同样的配置，侧边栏和卡片再点就接上它。
import type { ClearGuard } from "../core/clear-guard.ts";
import type { VideoRef } from "../core/video-ref.ts";
import type { SettingsStore } from "../platform/settings-store.ts";
import type { StorageArea } from "../platform/storage.ts";
import type { Tabs } from "../platform/tabs.ts";
import type { Broadcast } from "../shared/messages.ts";
import { SETTINGS_STORAGE_KEY } from "../shared/names.ts";
import { activationStatus } from "../shared/settings-schema.ts";
import type { SiteRules } from "../sites/types.ts";
import type { AiWiring } from "./ai.ts";
import type { Log } from "./log.ts";
import { createAutoGenerate, type AutoGenerate } from "./services/auto-generate.ts";
import type { OverviewService } from "./services/overview/index.ts";
import type { TranscriptService } from "./services/transcript/index.ts";
import type { OverviewStore } from "./stores/overviews.ts";
import type { TaskRunner } from "./tasks.ts";

export interface AutoWiringDeps {
  readonly settings: Pick<SettingsStore, "loadPublic">;
  readonly tabs: Pick<Tabs, "focusedWindow" | "activeTab">;
  readonly rules: readonly SiteRules[];
  readonly ai: Pick<AiWiring, "configCheck" | "freeze">;
  readonly tasks: Pick<TaskRunner, "register" | "list">;
  readonly overviews: Pick<OverviewStore, "find">;
  readonly transcript: Pick<TranscriptService, "knownDuration" | "light" | "ensure">;
  readonly overview: Pick<OverviewService, "generate">;
  /** 会话存储：尝试记录放在这里。 */
  readonly storage: StorageArea;
  readonly guard: ClearGuard;
  readonly now: () => number;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
}

export function createAutoWiring(deps: AutoWiringDeps): AutoGenerate {
  const { tasks, ai } = deps;
  const parseWatchUrl = (url: string): VideoRef | null => {
    for (const rule of deps.rules) {
      const ref = rule.parseWatchUrl(url);
      if (ref) return ref;
    }
    return null;
  };
  return createAutoGenerate({
    async settings() {
      const settings = await deps.settings.loadPublic();
      return {
        enabled: activationStatus(settings).state === "current",
        on: settings.autoOverview,
        minSec: settings.autoOverviewMinutes * 60,
        consent: { version: settings.dataConsentVersion, fingerprint: settings.dataConsentFingerprint },
      };
    },
    focusedWindow: deps.tabs.focusedWindow,
    activeTab: deps.tabs.activeTab,
    parseWatchUrl,
    configReady: async () => (await ai.configCheck()).ready,
    running: () => tasks.list().filter((task) => task.origin === "auto" && task.state === "running").length,
    hasOverview: async (video) => (await deps.overviews.find(video)) !== null,
    async duration(ref) {
      const known = await deps.transcript.knownDuration(ref);
      if (known !== null) return known;
      // 本机不知道：做一次卡片那样的轻量读取，卡片正在读就接上它，不为短视频去读字幕。
      await deps.transcript.light(ref).catch(() => undefined);
      return deps.transcript.knownDuration(ref);
    },
    async readTranscript(ref) {
      const snapshot = await deps.transcript.ensure(ref);
      return snapshot.ok ? { durationSec: snapshot.value.view.info.durationSec } : null;
    },
    async start(_ref, video, hooks) {
      // 和侧边栏、卡片点「生成概览」取定一样的配置：等价的请求接上同一个任务。
      const gen = await ai.freeze("analysis");
      const stages = [await ai.freeze("verdict")];
      const registered = await tasks.register({ kind: "overview", origin: "auto", video, gen, stages, followsPage: false }, {}, { send: hooks });
      if (!("task" in registered)) return { skipped: "conflict" };
      if (registered.joined) return { skipped: "joined" };
      return { done: deps.overview.generate(registered.task.id, video, { fresh: false }) };
    },
    storage: deps.storage,
    guard: deps.guard,
    now: deps.now,
    onPause: (paused) => deps.broadcast({ type: "auto.changed", paused }),
    log: deps.log,
  });
}

/** 这次存储变化是不是关掉或打开了开关：开关一动就从额度用完、密钥不对的暂停里恢复。 */
export function autoSwitchToggled(changes: Readonly<Record<string, { readonly oldValue?: unknown; readonly newValue?: unknown }>>, area: string): boolean {
  const change = area === "local" ? changes[SETTINGS_STORAGE_KEY] : undefined;
  if (!change) return false;
  const on = (value: unknown): boolean => (value as { readonly autoOverview?: unknown } | null | undefined)?.autoOverview === true;
  return on(change.oldValue) !== on(change.newValue);
}
