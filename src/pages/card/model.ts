// 卡片的状态和操作。认哪个视频只看所在标签页的地址；读数据只用轻量读取（官方总结和本机已有的概览，YouTube 只有后者）；
// 生成概览只认真实点击，登记时换到一次性令牌才开始；侧边栏为同一视频起的、打开就出结论自动起的任务就跟着看进度。
// 没启用、卡片关着时什么都不显示。展开收起的规则在 fold.ts（跟会话的模式、本窗口的侧边栏和手动展开收起）；
// 收起时不读，后台打开的标签页第一次到前台才读。收起的那一行写什么在 glance.ts（没有结论时播放到的章节、打不开侧边栏时临时说的一句话）。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { describe, type ErrorCode } from "../../core/errors.ts";
import { fixedInSettings } from "../../core/errors/settings-codes.ts";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import type { OverviewTranscriptBasis } from "../../core/notes/records.ts";
import type { TaskView } from "../../core/tasks.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { GuidesFailure, OfficialSummaryView } from "../../shared/messages/transcript.ts";
import type { PageApi } from "../shared/api.ts";
import type { ConfigState } from "../shared/config.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { createFold } from "./fold.ts";
import { conclusionOf, createGlance } from "./glance.ts";
import { cardTextOf } from "./text.ts";
import { CARD_ZH } from "./text-zh.ts";
import { createActionHold, realTimers, type CardTimers } from "./timers.ts";

export interface CardTab {
  readonly id: number;
  readonly url: string;
  /** 标签页所在的窗口：侧边栏按窗口开关。 */
  readonly windowId: number;
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
  readonly timers?: CardTimers;
  /** 卡片所在的标签页在不在前台；不给时当一直在前台。 */
  readonly page?: { visible(): boolean; onVisible(run: () => void): () => void };
  /** 本标签页的播放器播到第几秒；问不到（没连上、在播广告、视频换了）时是 null。不给就不写当前章节。 */
  readonly position?: (tabId: number, video: VideoKey) => Promise<number | null>;
  /** 界面语言：状态按写出来那一刻的语言写。不给时是中文。 */
  readonly lang?: () => UiLang;
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
  /** 摆着的概览里章节和结论各自依据的字幕指纹；生成中的临时概览没有。 */
  readonly transcriptBasis: OverviewTranscriptBasis | null;
  /** 本机有字幕时，现在用的那份的指纹：和上面的对不上就标「基于旧字幕」。 */
  readonly transcriptFingerprint: string | null;
  /** 结论还没写好：true 写「正在写」，字符串原样显示。 */
  readonly verdictPending: boolean | string;
  readonly noCaptions: boolean;
  /** 没登录 B 站：读得到视频信息，字幕要登录才读得到。 */
  readonly needLogin: boolean;
  /** 字幕要用户在侧边栏点读取才读的站（YouTube），本机还没有字幕：卡片不去读，先请用户在侧边栏读。 */
  readonly notRead: boolean;
  readonly task: TaskProgress | null;
  readonly settingsError: boolean;
  readonly notice: { readonly text: string; readonly tone: Tone; /** 模型服务报错时自己说的话。 */ readonly said?: string } | null;
  /** 章节（还没有概览时是官方提纲）默认只露前几条，点了「展开全部」才全露。换了视频回到默认。 */
  readonly showAll: boolean;
  /** 有 AI 概览时 B 站官方总结收成一行，点开才露。换了视频回到收着。 */
  readonly officialOpen: boolean;
  /** 这个视频的内容还在来：按钮行先不摆。 */
  readonly holdActions: boolean;
  /** 本窗口的侧边栏开着：卡片上不摆打开侧边栏的入口。 */
  readonly panelOpen: boolean;
  /** 收着时播放到的那一章，在 chaptersInOrder 里的序号；不知道时是 null。 */
  readonly chapterNow: number | null;
  /** 收起的那一行上临时说的一句话，没有时是空串。 */
  readonly headNote: string;
}

/** 章节和官方提纲默认露几条：卡片嵌在右栏里，太高会把下面的选集和推荐顶下去。 */
export const CARD_ROWS = 5;

/** 默认露出来的那几条。只多出一条时不藏：为一条去点「展开全部」不值当。 */
export function cardRows<T>(rows: readonly T[], showAll: boolean): readonly T[] {
  return showAll || rows.length <= CARD_ROWS + 1 ? rows : rows.slice(0, CARD_ROWS);
}

const INITIAL: CardView = {
  visible: false,
  collapsed: false,
  phase: "waiting",
  title: "",
  official: null,
  analysis: null,
  transcriptBasis: null,
  transcriptFingerprint: null,
  verdictPending: false,
  noCaptions: false,
  needLogin: false,
  notRead: false,
  task: null,
  settingsError: false,
  notice: null,
  showAll: false,
  officialOpen: false,
  holdActions: false,
  panelOpen: false,
  chapterNow: null,
  headNote: "",
};

const LOAD_TIMEOUT_MS = 30_000;
const EXTERNAL_CHECK_MS = 15_000;
const HIDDEN_CODES: ReadonlySet<ErrorCode> = new Set(["NOT_ENABLED", "CARD_DISABLED"]);
// 中文的这几句，测试拿来对照。
export const NO_CAPTIONS_TEXT = CARD_ZH.noCaptions;
export const NEED_LOGIN_TEXT = CARD_ZH.needLogin;
export const NOT_READ_TEXT = CARD_ZH.notRead;

/** 有章节或金句才算已经有概览；只有一句话结论的，「生成概览」照样留着。 */
export function hasOverview(analysis: LearningAnalysis | null): boolean {
  return Boolean(analysis?.chapters?.length || analysis?.keyQuotes?.length);
}

/** 章节按开始时间排好：收起那一行写「第几章」用，和侧边栏精读顶上那一条同一个顺序。 */
export function chaptersInOrder(analysis: LearningAnalysis | null): readonly { readonly startSec: number; readonly title: string }[] {
  return (analysis?.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.timestampSeconds))
    .map((chapter) => ({ startSec: chapter.timestampSeconds, title: typeof chapter.title === "string" ? chapter.title.trim() : "" }))
    .sort((a, b) => a.startSec - b.startSec);
}

const keyOf = (ref: VideoRef | null): VideoKey | null => {
  try {
    return ref ? videoKey(ref) : null;
  } catch {
    return null;
  }
};

export function createCardModel(deps: CardDeps) {
  const { api, timers = realTimers, position, lang = (): UiLang => "zh" } = deps;
  const view = signal<CardView>(INITIAL);
  const t = () => cardTextOf(lang());
  let tab: CardTab | null = null;
  let video: VideoKey | null = null;
  // 换视频、关掉卡片就加一：迟到的结果对不上就不渲染。
  let ticket = 0;
  let loadedTicket = -1;
  let saved: LearningAnalysis | null = null;
  let savedBasis: OverviewTranscriptBasis | null = null;
  const shownSaved = (): Pick<CardView, "analysis" | "transcriptBasis"> => ({ analysis: saved, transcriptBasis: savedBasis });
  const settled = new Set<string>();
  // 标签页到过前台：后台打开的标签页第一次切到前台才读。
  let seen = deps.page?.visible() ?? true;
  // 第一次问到侧边栏开没开之前不定展开收起：配置检查的结果先到，也等它。
  let ready = false;

  const patch = (next: Partial<CardView>): void => {
    view.value = { ...view.peek(), ...next };
    glance.sync();
  };
  const glance = createGlance({
    timers,
    visible: () => deps.page?.visible() ?? true,
    position: position ? () => (tab && video ? position(tab.id, video) : Promise.resolve(null)) : null,
    wanted: () => view.peek().visible && view.peek().collapsed && !view.peek().panelOpen && conclusionOf(view.peek()) === null,
    chapters: () => chaptersInOrder(view.peek().analysis),
    state: () => view.peek(),
    set: (next) => patch(next),
  });
  const notice = (text: string, tone: Tone = "", said?: string): Pick<CardView, "notice"> => ({ notice: text ? { text, tone, ...(said ? { said } : {}) } : null });
  const actionRow = createActionHold(timers.after, (held) => patch({ holdActions: held }));
  const fold = createFold({
    api,
    after: timers.after,
    video: () => video,
    windowId: () => tab?.windowId ?? null,
    collapsed: () => view.peek().collapsed,
    place(collapsed) {
      patch({ collapsed });
      // 重新摆过，收起那一行上之前说的那句话就不留了。
      glance.say("");
      if (!collapsed) void load();
    },
    panel: (open) => patch({ panelOpen: open }),
  });

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
    savedBasis = null;
    actionRow.reset();
    glance.say("");
    patch({ phase, title: "", official: null, analysis: null, transcriptBasis: null, transcriptFingerprint: null, verdictPending: false, noCaptions: false, notRead: false, task: null, settingsError: false, notice: null, showAll: false, officialOpen: false, holdActions: false });
  }

  function syncVideo(url: string): void {
    const next = keyOf(deps.parseVideo(url));
    if (next === video && view.peek().phase !== "waiting") return;
    const changed = next !== video;
    video = next;
    reset(next ? "loading" : "not-video");
    // 手动展开收起只管这一个视频：换了视频回到默认，先看新视频的会话定展开收起，再决定读不读。
    if (changed) fold.reset();
    if (!next) patch({ collapsed: false, ...notice(t().notVideo) });
    if (changed && next) fold.wait();
    else void load();
  }

  async function load(quiet = false): Promise<void> {
    const v = view.peek();
    if (!visible.peek() || !seen || v.collapsed || !video || (!quiet && loadedTicket === ticket)) return;
    const asked = ticket;
    const current = video;
    loadedTicket = asked;
    if (!quiet) {
      actionRow.hold();
      patch({ phase: "loading", ...notice(t().loading) });
    }
    const reply = await timers.timeout(api.send("transcript.get", { video: current, mode: "light" }), LOAD_TIMEOUT_MS);
    if (asked !== ticket) return;
    if (reply === "timeout") return failLoad(t().loadTimeout);
    if (!reply.ok) {
      if (HIDDEN_CODES.has(reply.code)) return void deps.recheckConfig();
      const known = (reply as GuidesFailure).overview;
      if (known) [saved, savedBasis] = [known.analysis, known.transcriptBasis ?? null];
      return failLoad(describe(reply.code, reply.detail, lang()), reply.said);
    }
    const value = reply.value;
    if (!("mode" in value) || value.video !== current) return failLoad(t().wrongVideo);
    [saved, savedBasis] = [value.overview?.analysis ?? null, value.overview?.transcriptBasis ?? null];
    const noCaptions = value.hasTranscript ? false : value.transcriptError === "NO_CAPTIONS" || view.peek().noCaptions;
    const needLogin = !value.hasTranscript && value.transcriptError === "NEED_LOGIN";
    // 能代开文字稿面板的构建里，本机没有字幕也能点生成：后台先经这个视频页读到字幕。
    const notRead = !value.hasTranscript && value.transcriptError === "NOT_CACHED" && !FEATURE_YOUTUBE_OPEN_PANEL;
    const following = view.peek().task;
    const blocked = hasOverview(saved) ? "" : needLogin ? t().needLogin : notRead ? t().notRead : noCaptions ? t().noCaptions : "";
    patch({
      phase: "loaded",
      title: value.info.title,
      official: value.official ?? null,
      noCaptions,
      needLogin,
      notRead,
      transcriptFingerprint: value.transcriptFingerprint ?? null,
      ...(following && !quiet ? {} : { ...shownSaved(), verdictPending: false }),
      ...(quiet ? {} : notice(blocked)),
    });
    // 没登录、本机还没有字幕：登录或在侧边栏读过以后，重试、收起再展开都要能重读，不当成已经读过。
    if (needLogin || notRead) loadedTicket = -1;
    // 官方总结还在读：按钮行接着等，再轻读一次，后台会等这次问询回来再答。
    if (value.official?.status !== "pending") actionRow.show();
    else if (!quiet && actionRow.holding()) void load(true);
    if (!quiet) await followRunning(asked);
  }

  function failLoad(text: string, said?: string): void {
    loadedTicket = -1;
    actionRow.show();
    patch({ phase: "failed", ...shownSaved(), ...notice(text, "error", said) });
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
    patch({ task: null, ...shownSaved(), verdictPending: false });
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
    if (v.task || v.phase !== "loaded" || v.noCaptions || v.notRead || hasOverview(saved)) return;
    const asked = ticket;
    const current = video;
    patch({ task: { id: "", external: false, auto: false, canceling: false, done: 0, total: 0, message: "" }, settingsError: false, ...notice("") });
    const started = await api.send("task.start", { kind: "overview", video: current });
    if (asked !== ticket) return;
    if (!started.ok) return finishOwn(null, started.code, describe(started.code, started.detail, lang()), started.said);
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
      return finishOwn(null, "TASK_CANCELED", t().stopped);
    }
    const result = await api.send("overview.start", { video: current, token });
    settled.add(task.id);
    if (asked !== ticket) return;
    if (!result.ok) return finishOwn(null, result.code, result.code === "TASK_CANCELED" ? t().stopped : describe(result.code, result.detail, lang()), result.said);
    const value = result.value;
    [saved, savedBasis] = [value.analysis, value.transcriptBasis ?? null];
    const text = value.saveFailed ? t().saveFailed : value.canceled ? t().stoppedSaved(value.savedChunks ?? 0, value.chunkCount ?? 0) : "";
    patch({ task: null, ...shownSaved(), verdictPending: false, ...notice(text, value.saveFailed ? "warn" : "") });
  }

  function finishOwn(analysis: LearningAnalysis | null, code: ErrorCode, text: string, said?: string): void {
    patch({
      task: null,
      ...(analysis ? { analysis, transcriptBasis: null } : shownSaved()),
      verdictPending: false,
      settingsError: fixedInSettings(code),
      noCaptions: view.peek().noCaptions || code === "NO_CAPTIONS",
      ...(code === "TASK_CANCELED" ? notice(text) : notice(text, "error", said)),
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
    // 进度行已经写着完成了几块，这里只说结论什么时候有。
    patch({ analysis: message.analysis, transcriptBasis: null, verdictPending: t().chaptersFirst });
  }

  const subscriptions = [
    api.on("task.changed", ({ task }) => onTask(task)),
    api.on("overview.preview", onPreview),
    // 章节落库了、结论还在写：重读一次，把存好的章节摆出来。
    api.on("overview.updated", (message) => {
      if (message.video !== video || !view.peek().task) return;
      void load(true).then(() => {
        if (view.peek().task && message.verdictPending) patch({ ...shownSaved(), verdictPending: true });
      });
    }),
    // 侧边栏给这个视频导入或移除了字幕文件：重读，看结论是不是基于旧字幕。收着时等展开再读。
    api.on("transcript.changed", (message) => {
      if (message.video !== video) return;
      loadedTicket = -1;
      void load(true);
    }),
    api.on("data.cleared", ({ scope }) => {
      reset(video ? "loading" : "not-video");
      if (scope === "cache") void load();
    }),
  ];
  let stopTimer: (() => void) | null = null;
  const stopWatching = deps.page?.onVisible(() => {
    // 回到前台顺手再问一次侧边栏：开关的广播万一漏了，这里补上。
    if (ready) void fold.readPanel();
    glance.seen();
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
      if (!tab) return patch({ phase: "failed", ...notice(t().noTab, "error") });
      // 先问到侧边栏开没开再定展开收起：开着时卡片一出来就是收起的，不先展开、读一次、再收起。
      await fold.readPanel();
      ready = true;
      syncVideo(tab.url);
    },
    /** 标签页被拖到了另一个窗口：侧边栏按窗口开关，按新窗口重新问，问不到当关着。 */
    async windowChanged(windowId: number): Promise<void> {
      if (!tab || windowId === tab.windowId) return;
      tab = { ...tab, windowId };
      await fold.readPanel();
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
      if (tab && ready) {
        if (view.peek().phase === "waiting") syncVideo(tab.url);
        else void load();
      }
    },
    urlChanged: (url: string) => syncVideo(url),
    recheck,
    retry: () => void load(),
    generate,
    cancel,
    toggle: () => fold.toggle(),
    /** 浏览器没让卡片直接打开侧边栏：展开着时在正文里说，收着时在那一行上说。 */
    panelRefused(): void {
      patch({ notice: { text: t().panelRefused, tone: "error" } });
      if (view.peek().collapsed) glance.say(t().panelRefusedNote);
    },
    toggleShowAll: (): void => patch({ showAll: !view.peek().showAll }),
    toggleOfficial: (): void => patch({ officialOpen: !view.peek().officialOpen }),
    seek(atSec: number): void {
      if (tab && video) deps.seek(tab.id, video, Math.floor(atSec));
    },
    tabId: () => tab?.id ?? null,
    stop(): void {
      stopTimer?.();
      fold.stop();
      glance.stop();
      actionRow.stop();
      stopWatching?.();
      for (const off of subscriptions) off();
    },
  };
}

export type CardModel = ReturnType<typeof createCardModel>;
