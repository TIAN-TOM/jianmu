// 打开就出结论的接线：设置、窗口和标签页、本机概览、取字幕和任务登记都从这里交给自动生成服务。
// 自动任务和用户点的「生成概览」登记成同一种任务、取定同样的配置，侧边栏和卡片再点就接上它。
// 要经页面读字幕的站（YouTube）只在交来了页面读取时才自动读：时长问视频页，字幕让视频页替用户点开文字稿面板再读。
import type { ClearGuard } from "../core/clear-guard.ts";
import type { ErrorCode } from "../core/errors.ts";
import type { VideoRef } from "../core/video-ref.ts";
import type { SettingsStore } from "../platform/settings-store.ts";
import type { StorageArea } from "../platform/storage.ts";
import type { Tabs } from "../platform/tabs.ts";
import type { Broadcast } from "../shared/messages.ts";
import type { TranscriptView } from "../shared/messages/transcript.ts";
import { SETTINGS_REVISION_KEY, SETTINGS_STORAGE_KEY } from "../shared/names.ts";
import { activationStatus } from "../shared/settings-schema.ts";
import { captionsInPage } from "../sites/rules.ts";
import type { SiteRules } from "../sites/types.ts";
import type { AiWiring } from "./ai.ts";
import type { Log } from "./log.ts";
import { createAutoGenerate, type AutoGenerate } from "./services/auto-generate.ts";
import { createPageTranscript, type PageTranscript, type PageTranscriptDeps } from "./services/page-transcript.ts";
import type { OverviewService } from "./services/overview/index.ts";
import type { TranscriptService } from "./services/transcript/index.ts";
import type { OverviewStore } from "./stores/overviews.ts";
import type { TaskRunner } from "./tasks.ts";

export interface AutoWiringDeps {
  readonly settings: Pick<SettingsStore, "loadPublic">;
  readonly tabs: Pick<Tabs, "focusedWindow" | "activeTab" | "allTabs">;
  /** 内容脚本匹配的视频页地址规则，含按授权动态注册的：只看这些网站的标签页。 */
  readonly watchPages: () => Promise<readonly string[]>;
  /** 经页面读字幕的站怎么读；构建里没有代开文字稿面板时是 null，这些站就不自动读。 */
  readonly pageTranscript: PageTranscript | null;
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
  readonly sleep: (ms: number) => Promise<void>;
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
    videoTabs: async () => (await deps.tabs.allTabs(await deps.watchPages())).map(({ tabId, url }) => ({ id: tabId, url })),
    parseWatchUrl,
    autoReads: (platform) => !captionsInPage(platform, deps.rules) || deps.pageTranscript !== null,
    configReady: async () => (await ai.configCheck()).ready,
    running: () => tasks.list().filter((task) => task.origin === "auto" && task.state === "running").length,
    hasOverview: async (video) => (await deps.overviews.find(video)) !== null,
    knownDuration: (ref) => deps.transcript.knownDuration(ref),
    async lightDuration(ref, tabId) {
      // 经页面读的站：本机不知道就问视频页，不点、不读字幕。
      if (captionsInPage(ref.platform, deps.rules)) return (await deps.transcript.knownDuration(ref)) ?? (await deps.pageTranscript?.duration(ref, tabId)) ?? null;
      // 做一次卡片那样的轻量读取，卡片正在读就接上它，不为短视频去读字幕。
      const reply = await deps.transcript.light(ref).catch(() => null);
      // 没登录时轻量读取读得到视频信息，但字幕要登录：和读字幕报要登录一样整批停下。
      const signedOut = reply?.ok && "mode" in reply.value && reply.value.transcriptError === "NEED_LOGIN";
      const stop = signedOut ? stopsReading("NEED_LOGIN") : reply && !reply.ok ? stopsReading(reply.code) : null;
      return stop ?? deps.transcript.knownDuration(ref);
    },
    async readTranscript(ref, tabId) {
      if (captionsInPage(ref.platform, deps.rules)) {
        const reply = (await deps.pageTranscript?.read(ref, tabId)) ?? null;
        if (reply === null) return null;
        if ("later" in reply) return "later";
        // 页面读不成只算这个视频读不成：不是平台整体读不了，不让别的视频跟着停。
        return reply.ok ? { durationSec: durationOf(reply.value) } : null;
      }
      const snapshot = await deps.transcript.ensure(ref);
      if (snapshot.ok) return { durationSec: snapshot.value.view.info.durationSec };
      return stopsReading(snapshot.code) ?? null;
    },
    async start(_ref, video, hooks) {
      // 和侧边栏、卡片点「生成概览」取定一样的配置：等价的请求接上同一个任务。
      const gen = await ai.freeze("analysis");
      const stages = [await ai.freeze("verdict")];
      const registered = await tasks.register({ kind: "overview", origin: "auto", video, gen, stages, followsPage: false }, {}, { send: hooks });
      if (!("task" in registered)) return { skipped: "conflict" };
      if (registered.joined) return { skipped: "joined" };
      // 打开就出结论也读评论区（PRD F23）；这里不知道是哪个标签页，YouTube 上读不到就不带评论。
      return { done: deps.overview.generate(registered.task.id, video, { fresh: false, comments: {} }) };
    },
    storage: deps.storage,
    guard: deps.guard,
    now: deps.now,
    sleep: deps.sleep,
    onPause: (paused) => deps.broadcast({ type: "auto.changed", paused }),
    log: deps.log,
  });
}

/** 视频页的地址规则：清单里的，加上已授权的站按授权动态注册的。 */
export function watchPagesOf(tabs: Pick<Tabs, "contentScripts">, granted: (() => Promise<readonly { readonly matches: readonly string[] }[]>) | undefined): () => Promise<readonly string[]> {
  const fixed = tabs.contentScripts().flatMap((script) => script.matches);
  return async () => [...fixed, ...((await granted?.()) ?? []).flatMap((script) => script.matches)];
}

/** 经页面读字幕的站怎么读：只有能代开文字稿面板的构建才有，关掉开关的构建里这一支连同那个模块一起裁掉。 */
export function pageTranscriptOf(deps: PageTranscriptDeps): PageTranscript | null {
  const create = FEATURE_YOUTUBE_OPEN_PANEL ? createPageTranscript : null;
  return create?.(deps) ?? null;
}

/** 读到的时长；页面上的视频还没加载出时长时，按最后一句字幕的结尾估。 */
function durationOf(view: TranscriptView): number {
  if (view.info.durationSec > 0) return view.info.durationSec;
  const last = view.transcript.cues.at(-1);
  return last ? last.start + last.duration : 0;
}

/**
 * 读平台失败以后自动生成要不要整批停下：被限流或要人机验证、没登录是这会儿整体读不了；返回读不懂的也停，
 * 分不清是整条路线还是这一个视频，这个视频另外记下不再读，免得每次都卡在它身上。其余的只算这个视频读不成。
 */
export function stopsReading(code: ErrorCode): "stop" | "broken" | null {
  if (code === "RATE_LIMITED" || code === "NEED_LOGIN") return "stop";
  return code === "MALFORMED" ? "broken" : null;
}

/**
 * 这次存储变化是不是设置页保存了新的密钥或服务地址：保存时修订号换新，只换外观、模型这类写入不换。
 * 因为密钥被拒停着的打开就出结论，保存成功以后自己恢复。
 */
export function aiCredentialsSaved(changes: Readonly<Record<string, { readonly oldValue?: unknown; readonly newValue?: unknown }>>, area: string): boolean {
  const change = area === "local" ? changes[SETTINGS_REVISION_KEY] : undefined;
  return typeof change?.newValue === "string" && change.newValue !== "" && change.newValue !== change.oldValue;
}

/**
 * 存储变化以后打开就出结论要不要从暂停里恢复：开关一动就恢复；因为密钥被拒停着时，设置页保存了新的密钥或地址也恢复，
 * 不用用户再点。额度用完、本机服务拒绝的要用户自己点「恢复」。
 */
export async function resumesAfter(
  changes: Readonly<Record<string, { readonly oldValue?: unknown; readonly newValue?: unknown }>>,
  area: string,
  auto: Pick<AutoGenerate, "paused">,
): Promise<boolean> {
  if (autoSwitchToggled(changes, area)) return true;
  return aiCredentialsSaved(changes, area) && (await auto.paused().catch(() => null)) === "key";
}

/** 这次存储变化是不是关掉或打开了开关：开关一动就从额度用完、密钥不对的暂停里恢复。 */
export function autoSwitchToggled(changes: Readonly<Record<string, { readonly oldValue?: unknown; readonly newValue?: unknown }>>, area: string): boolean {
  const change = area === "local" ? changes[SETTINGS_STORAGE_KEY] : undefined;
  if (!change) return false;
  const on = (value: unknown): boolean => (value as { readonly autoOverview?: unknown } | null | undefined)?.autoOverview === true;
  return on(change.oldValue) !== on(change.newValue);
}
