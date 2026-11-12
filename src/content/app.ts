// 内容脚本的生命周期：过了启用闸门才读页面，页面激活稳定后才挂界面，之后定时自查；启用失效时整套撤下、重新等确认。
// 扩展重新加载后旧脚本和扩展断了联系：撤卡片，笔记按钮留着只提示刷新页面。
import type { VideoKey } from "../core/video-ref.ts";
import type { Broadcast } from "../shared/messages.ts";
import type { AppearanceView } from "../shared/messages/core.ts";
import type { SitePage } from "../sites/page-types.ts";
import { createGate, type Activation, type Gate, type GateTimers } from "./gate.ts";
import { createPlaybackReporter, createPlayer, type Player } from "./player.ts";
import type { ContentRuntime } from "./runtime.ts";

/** 挂在页面上的一套界面。 */
export interface Surface {
  /** 定时自查：补回被摘掉的节点、核对位置。 */
  readonly tick: () => void;
  readonly videoChanged: () => void;
  readonly setAppearance: (view: AppearanceView) => void;
  /** 扩展断了联系：撤卡片，按钮改成提示刷新。 */
  readonly retire: () => void;
  readonly remove: () => void;
}

export interface SurfaceEnv {
  readonly player: Player;
  /** 扩展断了联系：交给生命周期收场。 */
  readonly retire: () => void;
}

export interface ContentAppDeps {
  readonly runtime: ContentRuntime;
  readonly page: SitePage;
  readonly createSurface: (env: SurfaceEnv) => Surface;
  /** 标签页在后台时定时自查跳过，切回来时立刻补一轮。 */
  readonly visibility: { readonly hidden: () => boolean; readonly onChange: (run: () => void) => () => void };
  /** 媒体元素开始加载新内容。 */
  readonly onMediaLoading: (run: () => void) => () => void;
  readonly every?: (ms: number, run: () => void) => () => void;
  readonly gateTimers?: GateTimers;
}

export interface ContentApp {
  readonly start: () => void;
  /** 整套撤下，不再响应任何消息：同一页面注入了新的一份时调。 */
  readonly stop: () => void;
  readonly gate: () => Gate;
}

export const TICK_MS = 800;

const repeat = (ms: number, run: () => void): (() => void) => {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** 只认后台的这几种广播；内容脚本收到的其余消息是播放器指令。 */
function broadcastOf(message: unknown): Broadcast | null {
  if (!isRecord(message)) return null;
  if (message.type === "activation.changed" && typeof message.confirmed === "boolean") return message as Broadcast;
  if (message.type === "data.cleared" && (message.scope === "all" || message.scope === "cache")) return message as Broadcast;
  if (message.type === "appearance.changed" && typeof message.accentTheme === "string" && typeof message.inPageCard === "boolean") return message as Broadcast;
  return null;
}

export function createContentApp(deps: ContentAppDeps): ContentApp {
  const { runtime, page, every = repeat } = deps;
  let session: AbortController | null = null;
  let player: Player | null = null;
  let surface: Surface | null = null;
  let retired = false;
  let appearanceVersion = 0;
  const cleanups: (() => void)[] = [];
  let stopListening: (() => void) | null = null;

  function retire(): void {
    if (retired) return;
    retired = true;
    for (const cleanup of cleanups.splice(0)) cleanup();
    surface?.retire();
  }

  function tick(): void {
    if (!runtime.alive()) return retire();
    if (retired || deps.visibility.hidden()) return;
    surface?.tick();
  }

  async function loadAppearance(): Promise<void> {
    const version = appearanceVersion;
    const reply = await runtime.send("appearance.get", {});
    if (reply.ok && version === appearanceVersion) surface?.setAppearance(reply.value);
  }

  async function open(): Promise<void> {
    const controller = new AbortController();
    session = controller;
    const current = createPlayer({ currentRef: () => page.currentRef(), findMainVideo: () => page.findMainVideo() });
    player = current;
    cleanups.push(deps.onMediaLoading(() => current.mediaLoading()));
    try {
      await page.whenPageReady(controller.signal);
    } catch {
      return;
    }
    if (session !== controller || retired) return;
    surface = deps.createSurface({ player: current, retire });
    const report = createPlaybackReporter({
      player: current,
      findMainVideo: () => page.findMainVideo(),
      report: (video: VideoKey, durationSec: number) => void runtime.send("playback.info", { video, durationSec }),
    });
    cleanups.push(
      page.onVideoChange(() => {
        current.videoChanged();
        surface?.videoChanged();
      }),
      every(TICK_MS, () => {
        tick();
        if (!retired) report();
      }),
      deps.visibility.onChange(tick),
    );
    tick();
    void loadAppearance();
  }

  function close(): void {
    session?.abort();
    session = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
    surface?.remove();
    surface = null;
    player = null;
  }

  const gate = createGate({
    ask: async (): Promise<Activation> => {
      const reply = await runtime.send("activation.get", {});
      if (!reply.ok) return "unknown";
      return reply.value.state === "current" ? "current" : "needed";
    },
    open: () => void open(),
    close,
    ...(deps.gateTimers ? { timers: deps.gateTimers } : {}),
  });

  function onMessage(message: unknown, _sender: unknown, reply: (value: unknown) => void): boolean {
    const broadcast = broadcastOf(message);
    if (broadcast?.type === "activation.changed") gate.notify(broadcast.confirmed ? "confirmed" : "lost");
    else if (broadcast?.type === "data.cleared") {
      if (broadcast.scope === "all") gate.notify("lost");
    } else if (broadcast?.type === "appearance.changed") {
      appearanceVersion += 1;
      surface?.setAppearance({ accentTheme: broadcast.accentTheme, inPageCard: broadcast.inPageCard });
    } else if (!broadcast && player && gate.isOpen() && !retired) {
      const answer = player.handle(message);
      if (answer) reply(answer);
    }
    return false;
  }

  return {
    start() {
      stopListening = runtime.listen(onMessage);
      gate.start();
    },
    stop() {
      stopListening?.();
      stopListening = null;
      gate.stop();
      close();
    },
    gate: () => gate,
  };
}
