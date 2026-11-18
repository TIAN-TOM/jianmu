// 卡片的状态和操作。认哪个视频只看所在标签页的地址；读数据只用轻量读取（官方总结和本机已有的概览）；
// 生成概览只认真实点击，登记时换到一次性令牌才开始；侧边栏为同一视频起的、打开就出结论自动起的任务就跟着看进度。
// 没启用、卡片关着时什么都不显示。展开收起跟着本标签页的观看会话：用户在这个视频里手动展开收起过的为准，
// 否则速览展开、精读收起（短视频进精读，所以默认收起）；收起时不读，后台打开的标签页第一次到前台才读。
// 新视频的会话要等内容脚本报了时长才有：先收着等它定模式，等不到再按速览展开，短视频就不会先展开、读一次、再收起。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { describe, type ErrorCode } from "../../core/errors.ts";
import type { CardOverride, Mode, SessionView } from "../../core/mode/types.ts";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import type { TaskView } from "../../core/tasks.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { GuidesFailure, OfficialSummaryView } from "../../shared/messages/transcript.ts";
import type { PageApi } from "../shared/api.ts";
import type { ConfigState } from "../shared/config.ts";

export interface CardTab {
  readonly id: number;
  readonly url: string;
}

export interface CardDeps {
  readonly api: Pick<PageApi, "send" | "on">;
  readonly config: ReadonlySignal<ConfigState>;
  readonly recheckConfig: () => Promise<void>;
  /** 卡片所在的标签页，读不到时是 null。 */
  readonly currentTab: () => Promise<CardTab | null>;
  readonly parseVideo: (url: string) => VideoRef | null;
  /** 让本标签页的播放器跳到这里。 */
  readonly seek: (tabId: number, video: VideoKey, atSec: number) => void;
  readonly timers?: {
    every(ms: number, run: () => void): () => void;
    timeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout">;
    /** 过这么久调一次，返回取消函数。 */
    after(ms: number, run: () => void): () => void;
  };
  /** 卡片所在的标签页在不在前台；不给时当一直在前台。 */
  readonly page?: { visible(): boolean; onVisible(run: () => void): () => void };
}

export type Tone = "" | "warn" | "error";

export interface TaskProgress {
  readonly id: string;
  readonly external: boolean;
  /** 打开就出结论自动起的。 */
  readonly auto: boolean;
  readonly canceling: boolean;
  readonly done: number;
  readonly total: number;
  readonly message: string;
}

export interface CardView {
  /** 没启用、卡片关着、还没问到：整张卡片不显示。 */
  readonly visible: boolean;
  readonly collapsed: boolean;
  readonly phase: "waiting" | "not-video" | "loading" | "loaded" | "failed";
  readonly title: string;
  readonly official: OfficialSummaryView | null;
  readonly analysis: LearningAnalysis | null;
  /** 结论还没写好：true 写「正在写」，字符串原样显示。 */
  readonly verdictPending: boolean | string;
  readonly noCaptions: boolean;
  /** 没登录 B 站：读得到视频信息，字幕要登录才读得到。 */
  readonly needLogin: boolean;
  readonly task: TaskProgress | null;
  readonly settingsError: boolean;
  readonly notice: { readonly text: string; readonly tone: Tone } | null;
}

const INITIAL: CardView = {
  visible: false,
  collapsed: false,
  phase: "waiting",
  title: "",
  official: null,
  analysis: null,
  verdictPending: false,
  noCaptions: false,
  needLogin: false,
  task: null,
  settingsError: false,
  notice: null,
};

const LOAD_TIMEOUT_MS = 30_000;
const EXTERNAL_CHECK_MS = 15_000;
/** 新视频的模式最多等这么久，等不到按速览展开。 */
export const SESSION_WAIT_MS = 2_000;
const HIDDEN_CODES: ReadonlySet<ErrorCode> = new Set(["NOT_ENABLED", "CARD_DISABLED"]);
const SETTINGS_CODES: ReadonlySet<ErrorCode> = new Set(["NO_AI_CONFIG", "NO_DATA_CONSENT", "INVALID_AI_KEY", "INVALID_BASE_URL", "NEED_HOST_PERMISSION", "MODEL_OR_ENDPOINT_NOT_FOUND", "ANTHROPIC_WORKSPACE_REQUIRED"]);
export const NO_CAPTIONS_TEXT = "这个视频没有 CC 字幕，生成不了概览。";
export const NEED_LOGIN_TEXT = "登录 B 站后才读得到字幕、生成概览；也可以在侧边栏导入字幕文件。";

/** 有章节或金句才算已经有概览；只有一句话结论的，「生成概览」照样留着。 */
export function hasOverview(analysis: LearningAnalysis | null): boolean {
  return Boolean(analysis?.chapters?.length || analysis?.keyQuotes?.length);
}

const realTimers = {
  every(ms: number, run: () => void): () => void {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  timeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  },
  after(ms: number, run: () => void): () => void {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const keyOf = (ref: VideoRef | null): VideoKey | null => {
  try {
    return ref ? videoKey(ref) : null;
  } catch {
    return null;
  }
};

export function createCardModel(deps: CardDeps) {
  const { api, timers = realTimers } = deps;
  const view = signal<CardView>(INITIAL);
  let tab: CardTab | null = null;
  let video: VideoKey | null = null;
  // 换视频、关掉卡片就加一：迟到的结果对不上就不渲染。
  let ticket = 0;
  let loadedTicket = -1;
  let saved: LearningAnalysis | null = null;
  const settled = new Set<string>();
  // 这个视频的手动展开收起和模式，从会话里读。
  let override: CardOverride | null = null;
  let mode: Mode | null = null;
  let sessionAsk = 0;
  // 正在等新视频的会话定模式：这里是「不等了」的收尾，没在等时是 null。
  let stopWaiting: (() => void) | null = null;
  // 标签页到过前台：后台打开的标签页第一次切到前台才读。
  let seen = deps.page?.visible() ?? true;

  const patch = (next: Partial<CardView>): void => {
    view.value = { ...view.peek(), ...next };
  };
  const notice = (text: string, tone: Tone = ""): Pick<CardView, "notice"> => ({ notice: text ? { text, tone } : null });

  const aiReady = computed<boolean | null>(() => {
    const state = deps.config.value;
    return state.state === "checked" ? state.view.ready : null;
  });
  const visible = computed(() => {
    const state = deps.config.value;
    if (state.state === "unknown") return false;
    return !(state.state === "failed" && HIDDEN_CODES.has(state.failure.code));
  });

  function reset(phase: CardView["phase"]): void {
    ticket += 1;
    loadedTicket = -1;
    saved = null;
    patch({ phase, title: "", official: null, analysis: null, verdictPending: false, noCaptions: false, task: null, settingsError: false, notice: null });
  }

  function syncVideo(url: string): void {
    const next = keyOf(deps.parseVideo(url));
    if (next === video && view.peek().phase !== "waiting") return;
    const changed = next !== video;
    video = next;
    reset(next ? "loading" : "not-video");
    // 手动展开收起只管这一个视频：换了视频回到默认，先看新视频的会话定展开收起，再决定读不读。
    if (changed) {
      override = null;
      mode = null;
      stopWaiting?.();
    }
    if (!next) patch({ collapsed: false, ...notice("这里不是视频播放页。") });
    if (changed && next) awaitMode();
    else void load();
  }

  const collapsedNow = (): boolean => (override ? override === "collapsed" : mode === "study");

  /** 新视频：先收着问会话，有了就按它的模式定；一直没有就等够了按速览展开。 */
  function awaitMode(): void {
    patch({ collapsed: true });
    const cancel = timers.after(SESSION_WAIT_MS, decide);
    stopWaiting = () => {
      cancel();
      stopWaiting = null;
    };
    void readSession();
  }

  /** 按现在知道的模式和手动展开收起定下来，展开就读。 */
  function decide(): void {
    stopWaiting?.();
    const collapsed = collapsedNow();
    patch({ collapsed });
    if (!collapsed) void load();
  }

  function applySession(session: SessionView | null): void {
    if (!session || session.video !== video) return;
    override = session.cardOverride ?? null;
    mode = session.mode;
    if (stopWaiting || collapsedNow() !== view.peek().collapsed) decide();
  }

  /** 读本标签页的会话：卡片只读得到自己所在的标签页。 */
  async function readSession(): Promise<void> {
    sessionAsk += 1;
    const asked = sessionAsk;
    const current = video;
    const reply = await api.send("session.get", {});
    if (asked !== sessionAsk || current !== video || !reply.ok) return;
    applySession(reply.value.session);
  }

  async function load(quiet = false): Promise<void> {
    const v = view.peek();
    if (!visible.peek() || !seen || v.collapsed || !video || (!quiet && loadedTicket === ticket)) return;
    const asked = ticket;
    const current = video;
    loadedTicket = asked;
    if (!quiet) patch({ phase: "loading", ...notice("正在读取这个视频的总结…") });
    const reply = await timers.timeout(api.send("transcript.get", { video: current, mode: "light" }), LOAD_TIMEOUT_MS);
    if (asked !== ticket) return;
    if (reply === "timeout") return failLoad("读取超时。可以点「重试」，也可以打开完整面板。");
    if (!reply.ok) {
      if (HIDDEN_CODES.has(reply.code)) return void deps.recheckConfig();
      const known = (reply as GuidesFailure).overview;
      if (known) saved = known.analysis;
      return failLoad(describe(reply.code, reply.detail));
    }
    const value = reply.value;
    if (!("mode" in value) || value.video !== current) return failLoad("读到的不是当前视频的数据。可以点「重试」再读一次。");
    saved = value.overview?.analysis ?? null;
    const noCaptions = value.hasTranscript ? false : value.transcriptError === "NO_CAPTIONS" || view.peek().noCaptions;
    const needLogin = !value.hasTranscript && value.transcriptError === "NEED_LOGIN";
    const following = view.peek().task;
    const blocked = hasOverview(saved) ? "" : needLogin ? NEED_LOGIN_TEXT : noCaptions ? NO_CAPTIONS_TEXT : "";
    patch({
      phase: "loaded",
      title: value.info.title,
      official: value.official ?? null,
      noCaptions,
      needLogin,
      ...(following && !quiet ? {} : { analysis: saved, verdictPending: false }),
      ...(quiet ? {} : notice(blocked)),
    });
    // 没登录：登录以后重试、收起再展开都要能重读，不当成已经读过。
    if (needLogin) loadedTicket = -1;
    if (!quiet) await followRunning(asked);
  }

  function failLoad(text: string): void {
    loadedTicket = -1;
    patch({ phase: "failed", analysis: saved, ...notice(text, "error") });
  }

  function progressOf(task: TaskView, external: boolean, canceling = false): TaskProgress {
    return { id: task.id, external, auto: task.origin === "auto", canceling, done: task.done, total: task.total, message: task.message };
  }

  // 侧边栏可能正在为这个视频生成概览：接上它的进度，不摆一个点了会被拦下的按钮。
  async function followRunning(asked: number): Promise<void> {
    if (view.peek().task) return;
    const reply = await api.send("task.list", {});
    if (!reply.ok || asked !== ticket || view.peek().task) return;
    const running = reply.value.tasks.find((task) => task.kind === "overview" && task.video === video && task.state === "running");
    if (running) follow(running);
  }

  function follow(task: TaskView): void {
    if (settled.has(task.id) || view.peek().task) return;
    patch({ task: progressOf(task, true), ...notice("") });
  }

  // 跟着的任务结束了：概览已经落进本机，重读一次就能摆出来；临时概览不留。
  function settle(id: string): void {
    settled.add(id);
    if (view.peek().task?.id !== id) return;
    patch({ task: null, analysis: saved, verdictPending: false });
    loadedTicket = -1;
    void load();
  }

  async function checkExternal(): Promise<void> {
    const task = view.peek().task;
    if (!task?.external) return;
    const reply = await api.send("task.list", {});
    if (!reply.ok || view.peek().task?.id !== task.id) return;
    const seen = reply.value.tasks.find((item) => item.id === task.id);
    if (seen?.state !== "running" && !seen?.finishing) settle(task.id);
  }

  async function generate(trusted: boolean): Promise<void> {
    // 花的是用户的额度：卡片嵌在别人的页面里，只认真实点击。
    if (!trusted || !visible.peek() || !video || aiReady.peek() === false) return;
    const v = view.peek();
    if (v.task || v.phase !== "loaded" || v.noCaptions || hasOverview(saved)) return;
    const asked = ticket;
    const current = video;
    patch({ task: { id: "", external: false, auto: false, canceling: false, done: 0, total: 0, message: "" }, settingsError: false, ...notice("") });
    const started = await api.send("task.start", { kind: "overview", video: current });
    if (asked !== ticket) return;
    if (!started.ok) return finishOwn(null, started.code, describe(started.code, started.detail));
    const { task, joined, token } = started.value;
    if (joined || !token) {
      patch({ task: null });
      return follow(task);
    }
    const canceling = view.peek().task?.canceling ?? false;
    patch({ task: progressOf(task, false, canceling) });
    // 登记的回答回来之前就点了停止：登记上了再取消一次，不开始生成。
    if (canceling) {
      await api.send("task.cancel", { taskId: task.id });
      settled.add(task.id);
      return finishOwn(null, "TASK_CANCELED", "已停止生成。");
    }
    const result = await api.send("overview.start", { video: current, token });
    settled.add(task.id);
    if (asked !== ticket) return;
    if (!result.ok) return finishOwn(null, result.code, result.code === "TASK_CANCELED" ? "已停止生成。" : describe(result.code, result.detail));
    const value = result.value;
    saved = value.analysis;
    const text = value.saveFailed
      ? "概览已生成，但没能保存到本机，以后打开可能要重新生成。"
      : value.canceled
        ? `已停止生成，已保存 ${value.savedChunks ?? 0}/${value.chunkCount ?? 0} 块，可以在完整面板里补失败块。`
        : "";
    patch({ task: null, analysis: saved, verdictPending: false, ...notice(text, value.saveFailed ? "warn" : "") });
  }

  function finishOwn(analysis: LearningAnalysis | null, code: ErrorCode, text: string): void {
    patch({
      task: null,
      analysis: analysis ?? saved,
      verdictPending: false,
      settingsError: SETTINGS_CODES.has(code),
      noCaptions: view.peek().noCaptions || code === "NO_CAPTIONS",
      ...notice(text, code === "TASK_CANCELED" ? "" : "error"),
    });
    if (code === "NO_AI_CONFIG") void deps.recheckConfig();
  }

  async function cancel(): Promise<void> {
    const task = view.peek().task;
    if (!task || task.canceling) return;
    patch({ task: { ...task, canceling: true } });
    if (!task.id) return;
    const reply = await api.send("task.cancel", { taskId: task.id });
    // 别处的任务后台说早就结束了：按结束收尾，不一直停在「正在停止」。
    if (task.external && !reply.ok) settle(task.id);
  }

  async function toggle(): Promise<void> {
    // 还在等会话时点了：以这一下为准，不等了。
    stopWaiting?.();
    const collapsed = !view.peek().collapsed;
    override = collapsed ? "collapsed" : "expanded";
    patch({ collapsed });
    if (!collapsed) void load();
    if (video) await api.send("card.setOverride", { video, value: override });
  }

  async function recheck(): Promise<void> {
    const found = await deps.currentTab();
    if (found && found.id === tab?.id) syncVideo(found.url);
  }

  function onTask(task: TaskView): void {
    if (task.video !== video || task.kind !== "overview") return;
    const own = view.peek().task;
    if (!own) {
      if (task.state === "running") follow(task);
      return;
    }
    if (own.id !== task.id) return;
    if (task.state === "running") patch({ task: { ...progressOf(task, own.external, own.canceling) } });
    else if (own.external && !task.finishing) settle(task.id);
  }

  function onPreview(message: { readonly taskId: string; readonly video: VideoKey; readonly analysis: LearningAnalysis; readonly done: number; readonly total: number }): void {
    if (message.video !== video || view.peek().task?.id !== message.taskId) return;
    patch({ analysis: message.analysis, verdictPending: `还在生成，已完成 ${message.done}/${message.total} 块` });
  }

  const subscriptions = [
    api.on("task.changed", ({ task }) => onTask(task)),
    api.on("overview.preview", onPreview),
    // 章节落库了、结论还在写：重读一次，把存好的章节摆出来。
    api.on("overview.updated", (message) => {
      if (message.video !== video || !view.peek().task) return;
      void load(true).then(() => {
        if (view.peek().task && message.verdictPending) patch({ analysis: saved, verdictPending: true });
      });
    }),
    // 本视频的模式变了（侧边栏里切的、播满 1 分钟自动切的）：重读自己标签页的会话，别的标签页同一视频的不算。
    api.on("session.changed", ({ session }) => {
      if (session.video === video) void readSession();
    }),
    api.on("data.cleared", ({ scope }) => {
      reset(video ? "loading" : "not-video");
      if (scope === "cache") void load();
    }),
  ];
  let stopTimer: (() => void) | null = null;
  const stopWatching = deps.page?.onVisible(() => {
    if (seen) return;
    seen = true;
    void load();
  });

  return {
    view,
    aiReady,
    visible,
    async start(): Promise<void> {
      stopTimer = timers.every(EXTERNAL_CHECK_MS, () => void checkExternal());
      tab = await deps.currentTab();
      if (!tab) return patch({ phase: "failed", ...notice("没能确认卡片所在的标签页。请打开完整面板查看总结。", "error") });
      syncVideo(tab.url);
    },
    /** 配置检查有了新结果：卡片从隐藏变成显示时接着读。 */
    configChanged(): void {
      const shown = visible.peek();
      patch({ visible: shown });
      if (!shown) {
        ticket += 1;
        loadedTicket = -1;
        return;
      }
      if (tab) {
        if (view.peek().phase === "waiting") syncVideo(tab.url);
        else void load();
      }
    },
    urlChanged: (url: string) => syncVideo(url),
    recheck,
    retry: () => void load(),
    generate,
    cancel,
    toggle,
    seek(atSec: number): void {
      if (tab && video) deps.seek(tab.id, video, Math.floor(atSec));
    },
    tabId: () => tab?.id ?? null,
    stop(): void {
      stopTimer?.();
      stopWaiting?.();
      stopWatching?.();
      for (const off of subscriptions) off();
    },
  };
}

export type CardModel = ReturnType<typeof createCardModel>;
