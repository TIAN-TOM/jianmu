// 内容脚本的生命周期：过了启用闸门才读页面，页面激活稳定后才挂界面，之后定时自查；启用失效时整套撤下、重新等确认。
// 扩展重新加载后旧脚本和扩展断了联系：撤卡片，笔记图标留着只提示刷新页面；补注入的新一份挂上来时，旧的整套撤下。
import { isRecord } from "../shared/guards.ts";
import type { Broadcast } from "../shared/messages.ts";
import { INJECTED } from "../shared/names.ts";
import type { AppearanceView } from "../shared/messages/core.ts";
import { repeat } from "../core/concurrency.ts";
import type { Platform } from "../core/video-ref.ts";
import type { SitePage } from "../sites/page-types.ts";
import type { FrameIdentity, FrameTool } from "./frame.ts";
import { createGate, type Activation, type Gate, type GateTimers } from "./gate.ts";
import { createPlaybackReporter } from "./play-reporter.ts";
import { createPlayer, type Player } from "./player.ts";
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
  /** 截帧工具，构建开关打开时才有。 */
  readonly frame?: FrameTool;
  /** 扩展断了联系：交给生命周期收场。 */
  readonly retire: () => void;
}

export interface ContentAppDeps {
  readonly runtime: ContentRuntime;
  readonly page: SitePage;
  /** 要用户另外授权的站要给：撤权的通知只认自己这个站的。 */
  readonly site?: Platform;
  readonly createSurface: (env: SurfaceEnv) => Surface;
  /** 标签页在后台时定时自查跳过，切回来时立刻补一轮。 */
  readonly visibility: { readonly hidden: () => boolean; readonly onChange: (run: () => void) => () => void };
  /** 媒体元素开始加载新内容。 */
  readonly onMediaLoading: (run: () => void) => () => void;
  /** 同一页面新注入了一份：开始时先喊一声，再听之后新的一份喊。 */
  readonly superseded: Superseded;
  /** 站点自己的页面读取（YouTube 的文字稿面板）：过了启用闸门才建，撤下时停；认得的后台问话由它回。 */
  readonly siteReader?: () => SiteReader;
  /** 闸门没放行（问到没启用、问不到）时调：页面主世界里先于闸门装上的东西靠它停下、清掉。 */
  readonly onHeld?: () => void;
  /** 撤了这个站的授权、整套撤下之前调，闸门开没开都调：页面主世界里不归闸门管的东西（YouTube 的小桥）靠它退场。 */
  readonly onRevoked?: () => void;
  /** 截帧工具的工厂，构建开关打开时才传：挂界面时建，撤下时停。 */
  readonly frame?: (identity: FrameIdentity) => FrameTool;
  readonly every?: (ms: number, run: () => void) => () => void;
  readonly gateTimers?: GateTimers;
}

/**
 * 新注入的一份叫旧的撤下。同一个扩展上下文里注入的几份共用一个隔离世界，入口靠全局变量就找得到旧的；
 * 扩展重新加载以后，新的一份在新的隔离世界里，看不到旧的全局变量，两边只共用页面，所以靠页面事件喊。
 * 页面脚本也能发这个事件，所以听到了只有和扩展断了联系的那份撤下，还连着的不理。
 */
export interface Superseded {
  readonly announce: () => void;
  readonly listen: (run: () => void) => () => void;
}

/** 用页面上的事件喊和听。 */
export function pageSuperseded(document: Pick<Document, "addEventListener" | "removeEventListener" | "dispatchEvent">): Superseded {
  return {
    announce: () => void document.dispatchEvent(new CustomEvent(INJECTED.contentRetire)),
    listen(run) {
      document.addEventListener(INJECTED.contentRetire, run);
      return () => document.removeEventListener(INJECTED.contentRetire, run);
    },
  };
}

export interface SiteReader {
  /** 认得的问话回 Promise，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<unknown> | null;
  readonly stop: () => void;
}

export interface ContentApp {
  readonly start: () => void;
  /** 整套撤下，不再响应任何消息：同一页面注入了新的一份时调。 */
  readonly stop: () => void;
  readonly gate: () => Gate;
}

export const TICK_MS = 800;

/** 只认后台的这几种广播；内容脚本收到的其余消息是播放器指令。 */
function broadcastOf(message: unknown): Broadcast | null {
  if (!isRecord(message)) return null;
  if (message.type === "activation.changed" && typeof message.confirmed === "boolean") return message as Broadcast;
  if (message.type === "data.cleared" && (message.scope === "all" || message.scope === "cache")) return message as Broadcast;
  if (message.type === "appearance.changed" && typeof message.accentTheme === "string" && typeof message.inPageCard === "boolean") return message as Broadcast;
  if (message.type === "site.changed" && typeof message.platform === "string" && typeof message.enabled === "boolean") return message as Broadcast;
  return null;
}

export function createContentApp(deps: ContentAppDeps): ContentApp {
  const { runtime, page, every = repeat } = deps;
  let session: AbortController | null = null;
  let player: Player | null = null;
  let frame: FrameTool | null = null;
  let reader: SiteReader | null = null;
  let surface: Surface | null = null;
  let retired = false;
  let appearanceVersion = 0;
  const cleanups: (() => void)[] = [];
  let stopListening: (() => void) | null = null;
  let stopSuperseded: (() => void) | null = null;

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
    const tool = deps.frame?.({ currentKey: current.currentKey, confirmed: current.confirmed, findMainVideo: () => page.findMainVideo() }) ?? null;
    frame = tool;
    if (tool) cleanups.push(() => tool.stop());
    // 读面板的要比界面先接上：面板内容的变化从这一刻起记。
    const siteReader = deps.siteReader?.() ?? null;
    reader = siteReader;
    if (siteReader) cleanups.push(() => siteReader.stop());
    try {
      await page.whenPageReady(controller.signal);
    } catch {
      return;
    }
    if (session !== controller || retired) return;
    surface = deps.createSurface({ player: current, retire, ...(tool ? { frame: tool } : {}) });
    const report = createPlaybackReporter({
      player: current,
      findMainVideo: () => page.findMainVideo(),
      ...(page.channelId ? { channelId: () => page.channelId?.() ?? null } : {}),
      sendInfo: (req) => runtime.send("playback.info", req),
      sendMilestone: (req) => runtime.send("playback.milestone", req),
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
    // 先报一次时长再挂界面：卡片一载入就按模式定展开收起，会话早一步有，短视频就不用先收着等。
    report();
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
    frame = null;
    reader = null;
  }

  const gate = createGate({
    ask: async (): Promise<Activation> => {
      const reply = await runtime.send("activation.get", {});
      if (!reply.ok) return "unknown";
      return reply.value.state === "current" ? "current" : "needed";
    },
    open: () => void open(),
    close,
    ...(deps.onHeld ? { held: deps.onHeld } : {}),
    ...(deps.gateTimers ? { timers: deps.gateTimers } : {}),
  });

  function onMessage(message: unknown, _sender: unknown, reply: (value: unknown) => void): boolean {
    const broadcast = broadcastOf(message);
    if (broadcast?.type === "activation.changed") gate.notify(broadcast.confirmed ? "confirmed" : "lost");
    else if (broadcast?.type === "data.cleared") {
      if (broadcast.scope === "all") gate.notify("lost");
    } else if (broadcast?.type === "site.changed") {
      // 撤了这个站的授权：整套撤下，不再响应任何消息。再启用时后台补注入新的一份。
      if (broadcast.platform === deps.site && !broadcast.enabled) {
        deps.onRevoked?.();
        stop();
      }
    } else if (broadcast?.type === "appearance.changed") {
      appearanceVersion += 1;
      // 语言选项原样带过去，播放页上的字跟着换；取值认不出时 lang.ts 按跟随浏览器算。
      surface?.setAppearance({ accentTheme: broadcast.accentTheme, inPageCard: broadcast.inPageCard, language: broadcast.language });
    } else if (!broadcast && player && gate.isOpen() && !retired) {
      const answer = player.handle(message);
      if (answer) reply(answer);
      // 截帧要等下一帧、编码，读面板要等它加载完，都异步回；回 true 让消息通道等着。
      const pending = answer ? null : (frame?.handle(message) ?? reader?.handle(message));
      if (pending) {
        void pending.then(reply, () => reply({ ok: false, code: "FRAME_NOT_READY" }));
        return true;
      }
    }
    return false;
  }

  function stop(): void {
    stopSuperseded?.();
    stopSuperseded = null;
    stopListening?.();
    stopListening = null;
    gate.stop();
    close();
  }

  return {
    start() {
      // 先喊再听：自己喊的自己听不到。
      deps.superseded.announce();
      stopSuperseded = deps.superseded.listen(() => {
        if (!runtime.alive()) stop();
      });
      stopListening = runtime.listen(onMessage);
      gate.start();
    },
    stop,
    gate: () => gate,
  };
}
