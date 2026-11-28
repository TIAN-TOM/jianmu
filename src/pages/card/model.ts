// 卡片的状态和操作。认哪个视频只看所在标签页的地址；读数据只用轻量读取（官方总结和本机已有的概览，YouTube 只有后者）；
// 生成概览只认真实点击，登记时换到一次性令牌才开始；侧边栏为同一视频起的、打开就出结论自动起的任务就跟着看进度。
// 没启用、卡片关着时什么都不显示。展开收起的规则在 fold.ts（跟会话的模式、本窗口的侧边栏和手动展开收起）；
// 收起时不读，后台打开的标签页第一次到前台才读。收起的那一行写什么在 glance.ts（没有结论时播放到的章节、打不开侧边栏时临时说的一句话）。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { describe, type ErrorCode } from "../../core/errors.ts";
import { fixedInSettings } from "../../core/errors/settings-codes.ts";
import type { LearningAnalysis, OverviewTranscriptBasis } from "../../core/notes/records.ts";
import type { TaskKind, TaskView } from "../../core/tasks.ts";
import { parseVideoKey, videoKeyOrNull, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { GuidesFailure } from "../../shared/messages/transcript.ts";
import { captionsInPage } from "../../sites/rules.ts";
import type { PageApi } from "../shared/api.ts";
import type { ConfigState } from "../shared/config.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { createCardAsk } from "./ask.ts";
import { createFold } from "./fold.ts";
import { INITIAL, type CardView, type TaskProgress, type Tone } from "./view.ts";
import { canWriteFromOfficial, writeFromOfficial } from "./official-verdict.ts";
import { chaptersInOrder, hasOverview } from "./rows.ts";
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

export { CARD_ROWS, cardRows, chaptersInOrder, hasOverview } from "./rows.ts";

export type { CardView, TaskProgress, Tone } from "./view.ts";

const LOAD_TIMEOUT_MS = 30_000;
/** 「重新生成」的确认摆出来多久以后才认。 */
export const CONFIRM_ARM_MS = 700;
/** 卡片跟着看进度的任务种类：生成概览和用官方总结写结论。 */
const FOLLOWED: ReadonlySet<TaskKind> = new Set<TaskKind>(["overview", "verdict"]);
const EXTERNAL_CHECK_MS = 15_000;
const HIDDEN_CODES: ReadonlySet<ErrorCode> = new Set(["NOT_ENABLED", "CARD_DISABLED"]);
// 中文的这几句，测试拿来对照。
export const NO_CAPTIONS_TEXT = CARD_ZH.noCaptions;
export const NEED_LOGIN_TEXT = CARD_ZH.needLogin;
export const NOT_READ_TEXT = CARD_ZH.notRead;

/** 这个视频的字幕后台会自己去读（登录着时）；要用户点了才经页面读的站和认不出的视频键都不算。 */
const serviceReads = (video: VideoKey): boolean => {
  const ref = parseVideoKey(video);
  return ref !== null && !captionsInPage(ref.platform);
};

export function createCardModel(deps: CardDeps) {
  const { api, timers = realTimers, position, lang = (): UiLang => "zh" } = deps;
  const view = signal<CardView>(INITIAL);
  const t = () => cardTextOf(lang());
  const ask = createCardAsk({ api, video: () => video, lang });
  let tab: CardTab | null = null;
  let video: VideoKey | null = null;
  // 换视频、关掉卡片就加一：迟到的结果对不上就不渲染。
  let ticket = 0;
  let loadedTicket = -1;
  let saved: LearningAnalysis | null = null;
  let savedBasis: OverviewTranscriptBasis | null = null;
  // 本机这份概览里没生成出来的分块数：有就摆「补上缺的部分」。
  let savedFailures = 0;
  // 「重新生成」的确认摆出来够久了才认。
  let confirmArmed = false;
  let disarm: (() => void) | null = null;
  const keep = (analysis: LearningAnalysis | null, basis: OverviewTranscriptBasis | null | undefined, failures: readonly unknown[] | undefined): void => {
    [saved, savedBasis, savedFailures] = [analysis, basis ?? null, failures?.length ?? 0];
  };
  const shownSaved = (): Pick<CardView, "analysis" | "transcriptBasis" | "failedParts"> => ({ analysis: saved, transcriptBasis: savedBasis, failedParts: savedFailures });
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
  const actionHold = createActionHold(timers.after, (held) => patch({ holdActions: held }));
  const fold = createFold({
    api,
    after: timers.after,
    video: () => video,
    windowId: () => tab?.windowId ?? null,
    collapsed: () => view.peek().collapsed,
    place(collapsed) {
      patch({ collapsed, more: collapsed ? "closed" : view.peek().more });
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
    savedFailures = 0;
    actionHold.reset();
    glance.say("");
    ask.reset();
    patch({ phase, title: "", official: null, analysis: null, transcriptBasis: null, failedParts: 0, more: "closed", transcriptFingerprint: null, verdictPending: false, noCaptions: false, notRead: false, canAsk: false, task: null, settingsError: false, notice: null, showAll: false, officialOpen: false, commentsOpen: false, holdActions: false });
  }

  function syncVideo(url: string): void {
    const next = videoKeyOrNull(deps.parseVideo(url));
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
      actionHold.hold();
      patch({ phase: "loading", ...notice(t().loading) });
    }
    const reply = await timers.timeout(api.send("transcript.get", { video: current, mode: "light" }), LOAD_TIMEOUT_MS);
    if (asked !== ticket) return;
    if (reply === "timeout") return failLoad(t().loadTimeout);
    if (!reply.ok) {
      if (HIDDEN_CODES.has(reply.code)) return void deps.recheckConfig();
      const known = (reply as GuidesFailure).overview;
      if (known) keep(known.analysis, known.transcriptBasis, known.analysisFailures);
      return failLoad(describe(reply.code, reply.detail, lang()), reply.said);
    }
    const value = reply.value;
    if (!("mode" in value) || value.video !== current) return failLoad(t().wrongVideo);
    keep(value.overview?.analysis ?? null, value.overview?.transcriptBasis, value.overview?.analysisFailures);
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
      // 问答要整份字幕：B 站登录着时后台自己去读，YouTube 只用本机已有的。
      canAsk: !noCaptions && !needLogin && (value.hasTranscript || serviceReads(current)),
      transcriptFingerprint: value.transcriptFingerprint ?? null,
      ...(following && !quiet ? {} : { ...shownSaved(), verdictPending: false }),
      // 安静重读不动提示，只有原来挡着的「没有字幕」这次不成立了（比如刚导入了字幕文件）才撤下。
      ...(quiet ? (view.peek().noCaptions && !noCaptions ? notice("") : {}) : notice(blocked)),
    });
    // 没登录、本机还没有字幕：登录或在侧边栏读过以后，重试、收起再展开都要能重读，不当成已经读过。
    if (needLogin || notRead) loadedTicket = -1;
    // 官方总结还在读：生成等操作接着等，再轻读一次，后台会等这次问询回来再答。
    if (value.official?.status !== "pending") actionHold.show();
    else if (!quiet && actionHold.holding()) void load(true);
    if (!quiet) await followRunning(asked);
  }

  function failLoad(text: string, said?: string): void {
    loadedTicket = -1;
    actionHold.show();
    patch({ phase: "failed", ...shownSaved(), ...notice(text, "error", said) });
  }

  function progressOf(task: TaskView, external: boolean, canceling = false): TaskProgress {
    return { id: task.id, external, auto: task.origin === "auto", ...(task.kind === "verdict" ? { verdict: true as const } : {}), canceling, done: task.done, total: task.total, message: task.message };
  }

  // 侧边栏可能正在为这个视频生成概览或用官方总结写结论：接上它的进度，不摆一个点了会被拦下的按钮。
  async function followRunning(asked: number): Promise<void> {
    if (view.peek().task) return;
    const reply = await api.send("task.list", {});
    if (!reply.ok || asked !== ticket || view.peek().task) return;
    const running = reply.value.tasks.find((task) => FOLLOWED.has(task.kind) && task.video === video && task.state === "running");
    if (running) follow(running);
  }

  function follow(task: TaskView): void {
    if (settled.has(task.id) || view.peek().task) return;
    patch({ task: progressOf(task, true), more: "closed", ...notice("") });
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

  /** 新生成只在还没有概览时；重新生成和补上缺的部分只在已经有概览时，后者还要有没生成出来的分块。 */
  async function generate(trusted: boolean, how: "new" | "fresh" | "retry" = "new"): Promise<void> {
    // 花的是用户的额度：卡片嵌在别人的页面里，只认真实点击。
    if (!trusted || !visible.peek() || !video || aiReady.peek() === false) return;
    const v = view.peek();
    if (v.task || v.phase !== "loaded" || v.noCaptions || v.notRead || hasOverview(saved) !== (how !== "new") || (how === "retry" && savedFailures === 0) || (how === "fresh" && !(v.more === "confirm" && confirmArmed))) return;
    const asked = ticket;
    const current = video;
    patch({ task: { id: "", external: false, auto: false, canceling: false, done: 0, total: 0, message: "" }, more: "closed", settingsError: false, ...notice("") });
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
    const result = how === "retry" ? await api.send("overview.retryFailed", { video: current, token }) : await api.send("overview.start", { video: current, token, ...(how === "fresh" ? { fresh: true } : {}) });
    settled.add(task.id);
    if (asked !== ticket) return;
    if (!result.ok) {
      const text = result.code === "TASK_CANCELED" ? t().stopped : result.code === "CARD_RATE_LIMITED" && result.detail === "regenerate" ? t().regenerateTooSoon : describe(result.code, result.detail, lang());
      return finishOwn(null, result.code, text, result.said);
    }
    const value = result.value;
    keep(value.analysis, value.transcriptBasis, value.analysisFailures);
    // 重新生成的章节写好了、结论没写成或被停：生效的还是原来那份，照实说，免得以为换过了。
    const kept = value.draftKept ? (value.verdictCanceled ? t().regenerateStopped : t().regenerateKept) : "";
    const text = value.saveFailed ? t().saveFailed : kept || (value.canceled ? t().stoppedSaved(value.savedChunks ?? 0, value.chunkCount ?? 0) : "");
    patch({ task: null, ...shownSaved(), verdictPending: false, ...notice(text, value.saveFailed || (kept && !value.verdictCanceled) ? "warn" : "") });
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

  async function fromOfficial(trusted: boolean): Promise<void> {
    // 花的是用户的额度：和「生成概览」一样只认真实点击。
    if (!trusted || !visible.peek() || !video || !canWriteFromOfficial(view.peek(), aiReady.peek())) return;
    const asked = ticket;
    patch({ task: { id: "", external: false, auto: false, verdict: true, canceling: false, done: 0, total: 0, message: "" }, more: "closed", settingsError: false, ...notice("") });
    const outcome = await writeFromOfficial(api, video, (task) => {
      const canceling = asked === ticket && (view.peek().task?.canceling ?? false);
      if (asked === ticket) patch({ task: progressOf(task, false, canceling) });
      return asked === ticket && !canceling;
    });
    if (outcome.kind !== "joined" && outcome.taskId) settled.add(outcome.taskId);
    if (asked !== ticket) return;
    if (outcome.kind === "joined") return void (patch({ task: null }), follow(outcome.task));
    if (outcome.kind === "failed") return finishOwn(null, outcome.code, outcome.code === "TASK_CANCELED" ? t().stopped : describe(outcome.code, outcome.detail, lang()), outcome.said);
    keep(outcome.value.analysis, outcome.value.transcriptBasis, outcome.value.analysisFailures);
    patch({ task: null, ...shownSaved(), verdictPending: false, ...(outcome.value.saveFailed ? notice(t().saveFailed, "warn") : notice("")) });
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
    if (task.video !== video) return;
    const own = view.peek().task;
    if (!own) {
      if (FOLLOWED.has(task.kind) && task.state === "running") follow(task);
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
    // 章节落库了、结论还在写：重读一次，把存好的章节摆出来。没跟着任务时（比如别处刚写好结论）也安静重读一次。
    api.on("overview.updated", (message) => {
      if (message.video !== video) return;
      if (!view.peek().task) return void load(true);
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
      patch(shown ? { visible: true } : { visible: false, more: "closed" });
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
    retryFailed: (trusted: boolean) => generate(trusted, "retry"),
    toggleMore: () => patch({ more: view.peek().more === "closed" ? "actions" : "closed" }),
    /** 「重新生成」先问一句：点了才摆确认，确认那一下才花额度。 */
    askRegenerate(): void {
      const open = view.peek().more !== "confirm";
      // 确认摆出来一会儿以后才认：连点两下，第二下落在确认上也不算。
      // 上一次的计时先撤掉：取消以后马上再点开，不能借上一次的计时提前生效。
      disarm?.();
      disarm = null;
      confirmArmed = false;
      if (open) disarm = timers.after(CONFIRM_ARM_MS, () => void (confirmArmed = true));
      patch({ more: open ? "confirm" : "actions" });
    },
    regenerate: (trusted: boolean) => generate(trusted, "fresh"),
    fromOfficial,
    ask,
    cancel,
    toggle: () => fold.toggle(),
    /** 浏览器没让卡片直接打开侧边栏：展开着时在正文里说，收着时在那一行上说。 */
    panelRefused(): void {
      patch({ notice: { text: t().panelRefused, tone: "error" } });
      if (view.peek().collapsed) glance.say(t().panelRefusedNote);
    },
    toggleShowAll: (): void => patch({ showAll: !view.peek().showAll }),
    toggleOfficial: (): void => patch({ officialOpen: !view.peek().officialOpen, more: "closed" }),
    toggleComments: (): void => patch({ commentsOpen: !view.peek().commentsOpen }),
    seek(atSec: number): void {
      if (tab && video) deps.seek(tab.id, video, Math.floor(atSec));
    },
    tabId: () => tab?.id ?? null,
    stop(): void {
      stopTimer?.();
      fold.stop();
      glance.stop();
      actionHold.stop();
      stopWatching?.();
      for (const off of subscriptions) off();
    },
  };
}

export type CardModel = ReturnType<typeof createCardModel>;
