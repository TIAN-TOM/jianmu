// 卡片样张：页面测试时现编进测试用的扩展副本，不进产品包。数据都是自造的，内容故意很长。
// 地址带 #full 时是全部展开、正在生成的样子（进度行、「停止」和「打开侧边栏」都在），带 #collapsed 时是收起的一行，
// 带 #official 时是还没有概览、只有一段不长的官方总结，带 #setup-key 时是还没有概览、以前配好过 AI 服务但密钥清空了（说明用产品里的 cardSetupHint），
// 带 #youtube 时是 YouTube 上已有概览、本机没有字幕（没有官方总结），带 #youtube-unread 时是没有代开文字稿的构建里，YouTube 上本机既没有概览也没有字幕，
// 带 #youtube-ready 时是 YouTube 上还没有概览、字幕已经读过；带 #comments 时结论带着评论区；带 #failed-parts 时概览有两块没生成出来；
// 带 #ask 时能提问，提问接上真实的提问状态（ask.ts），后台换成本页的替身，回答带一个能点的时间点；不带时是刚打开的默认样子；
// 「展开全部」和官方总结那一行点得动。卡片的界面组件原样用，样式用产品的 card.css。界面语言照卡片入口那样跟着设置。
// 带 #official-late、#official-never 时接上真实的卡片模型，后台换成本页的替身：官方总结先回「还在读」，
// 前者过一会儿读到、照后台的做法广播一次重读，后者一直读不到。带 #load-failed 时也接上真实的卡片模型，后台说被平台限流，
// 卡片按界面语言写原因。地址带 ?verdict=<档位> 时结论换成那一档（默认「可以看」），量判断词长短不一时的版面。
import { signal } from "@preact/signals";
import { render } from "preact";
import { videoKey } from "../../../src/core/video-ref.ts";
import { createCardAsk } from "../../../src/pages/card/ask.ts";
import { Card, type CardActions } from "../../../src/pages/card/card.tsx";
import { PANEL_REFUSED_NOTE } from "../../../src/pages/card/glance.ts";
import { createCardModel, NOT_READ_TEXT, type CardView } from "../../../src/pages/card/model.ts";
import { createPageApi, type PageRuntime } from "../../../src/pages/shared/api.ts";
import { cardSetupHint, type ConfigState } from "../../../src/pages/shared/config.ts";
import { bindDocumentLang, initUiLang, setUiLanguage, uiLang } from "../../../src/pages/shared/ui-lang.ts";
import { cardTextOf } from "../../../src/pages/card/text.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";

const LONG = "这是一段自造的样例文字，用来把卡片撑得很高，看底部的按钮会不会被裁掉。";
const full = location.hash === "#full";
// 收起的一行：#collapsed 只有名字（没读过）；#collapsed-glance 有结论、也知道播到哪，写的是一句话结论；
// #collapsed-chapters 只有章节没有结论，写播放到的章节；#collapsed-note 带临时说的那句话（打不开侧边栏时）；
// #collapsed-verdict 有结论、不知道播到哪，同样写一句话结论；
// #collapsed-yield 是侧边栏开着、让位收起，没有打开侧边栏的入口。#open-yield 是侧边栏开着时手动点开的，按钮行里没有「打开侧边栏」。
const collapsed = location.hash.startsWith("#collapsed");
const chaptersOnly = location.hash === "#collapsed-chapters";
// 只有官方总结：正文一百来个字，提纲 3 段。很窄的卡片加大字号时三行放不下，很宽的卡片标准字号时放得下；
// 宽窄差得开，换一套字体、字宽不一样也照样成立。
const officialOnly = location.hash === "#official";
const keyCleared = location.hash === "#setup-key";
// YouTube 没有官方总结；本机没有字幕时卡片不去读，请用户先在侧边栏读。
const youtube = location.hash.startsWith("#youtube");
const unread = location.hash === "#youtube" || location.hash === "#youtube-unread";
const noOverview = location.hash === "#youtube-unread" || location.hash === "#youtube-ready";
// 换过字幕：结论和章节都依据旧的那份。
const stale = location.hash === "#stale";
// 结论带着评论区：口碑一行，两条要点，各挂一条原评论。
const withComments = location.hash === "#comments";
const SAMPLE_COMMENTS = {
  tag: "有争议",
  line: "样例评论区的一句话",
  points: [
    { text: "样例要点一", quotes: [{ text: "样例原评论一", likes: 120, pinned: true }] },
    { text: "样例要点二", quotes: [{ text: "样例原评论二", likes: 8 }] },
  ],
  marks: [],
};
const KEY_CLEARED: ConfigState = { state: "checked", view: { ready: false, errors: [], missing: "key" } };
const SHORT_SUMMARY = "这是一段自造的官方总结，一共一百来个字，用来看正文被截成三行以后，底下还有没有藏着的字。卡片很宽的时候三行放得下，一个字都不藏；卡片很窄、字号又调大的时候三行放不下，后面的字就被截掉了，这时候要有地方点开看全。";

const view = signal<CardView>({
  visible: true,
  collapsed,
  phase: "loaded",
  title: `样例长视频：${LONG}`,
  official: keyCleared || youtube ? null : {
    status: "ok",
    summary: officialOnly ? SHORT_SUMMARY : LONG.repeat(6),
    outline: Array.from({ length: officialOnly ? 3 : 12 }, (_, index) => ({
      title: officialOnly ? `样例小节 ${index + 1}` : `样例小节 ${index + 1}：${LONG}`,
      timestamp: index * 60,
      points: officialOnly ? [] : [{ timestamp: index * 60 + 10, content: LONG }],
    })),
  },
  analysis: officialOnly || keyCleared || noOverview || location.hash === "#collapsed" ? null : {
    chapters: Array.from({ length: 16 }, (_, index) => ({ title: `样例章节 ${index + 1}：${LONG}`, timestampSeconds: index * 90 })),
    // 重点是第 2 章和第 11 章：一个时间四位、一个五位，章节名要和别的章对齐。
    ...(chaptersOnly ? {} : { verdict: { verdict: new URLSearchParams(location.search).get("verdict") || "可以看", summary: LONG.repeat(2), keyStarts: [90, 900], ...(withComments ? { comments: SAMPLE_COMMENTS } : {}) } }),
  },
  transcriptBasis: stale ? { chapters: "old-sample", verdict: "old-sample" } : null,
  failedParts: location.hash === "#failed-parts" ? 2 : 0,
  confirmRegenerate: false,
  transcriptFingerprint: stale ? "new-sample" : null,
  verdictPending: false,
  noCaptions: false,
  needLogin: false,
  notRead: unread,
  canAsk: location.hash === "#ask",
  task: full ? { id: "sample", external: false, auto: false, canceling: false, done: 3, total: 8, message: "" } : null,
  settingsError: false,
  notice: full ? { text: LONG, tone: "" } : location.hash === "#youtube-unread" ? { text: NOT_READ_TEXT, tone: "" } : null,
  showAll: full,
  officialOpen: full,
  commentsOpen: false,
  holdActions: false,
  panelOpen: location.hash === "#collapsed-yield" || location.hash === "#open-yield",
  // 播放到第 11 章（有结论时收起那一行不写它）；#collapsed-note 时临时说一句话（打不开侧边栏时说的那句）；#collapsed-verdict 时不知道播到哪。
  chapterNow: collapsed && location.hash !== "#collapsed" && location.hash !== "#collapsed-verdict" ? 10 : null,
  headNote: location.hash === "#collapsed-note" ? PANEL_REFUSED_NOTE : "",
});

const noop = (): void => undefined;
const actions: CardActions = {
  toggle: () => void (view.value = { ...view.value, collapsed: !view.value.collapsed }),
  generate: noop,
  fromOfficial: noop,
  retryFailed: noop,
  askRegenerate: () => void (view.value = { ...view.value, confirmRegenerate: !view.value.confirmRegenerate }),
  regenerate: noop,
  ask: noop,
  cancelAsk: noop,
  cancel: noop,
  retry: noop,
  openPanel: noop,
  openSettings: noop,
  seek: noop,
  toggleShowAll: () => void (view.value = { ...view.value, showAll: !view.value.showAll }),
  toggleOfficial: () => void (view.value = { ...view.value, officialOpen: !view.value.officialOpen }),
  toggleComments: () => void (view.value = { ...view.value, commentsOpen: !view.value.commentsOpen }),
};

// #ask：提问的状态原样用，后台的两条回复在这里现编；点了回答里的时间点，记在 window.__seeked 上给测试看。
const askRuntime: PageRuntime = {
  id: "card-sample",
  sendMessage: async (message) => {
    const { type, req } = message as { readonly type: string; readonly req: { readonly question?: string } };
    if (type === "task.start") return { ok: true, value: { task: { id: "ask-1", kind: "qa", origin: "card", video: videoKey(SAMPLE_REF), state: "running", done: 0, total: 0, phase: "", message: "", createdAt: 1, updatedAt: 1 }, joined: false, token: "ask-token" } };
    if (type === "qa.ask") return { ok: true, value: { entry: { id: "qa-1", video: videoKey(SAMPLE_REF), question: "样例问题", answer: "样例回答在 [1:30] 讲到。", citations: [], clickable: [90], derived: {}, createdAt: 1 }, retrievalMode: "full" } };
    return { ok: false, code: "UNKNOWN_ROUTE", req };
  },
  onMessage: { addListener: noop, removeListener: noop },
  connect: () => {
    throw new Error("样张不开长连接");
  },
};
const sampleAsk = createCardAsk({ api: createPageApi({ runtime: askRuntime }), video: () => videoKey(SAMPLE_REF), lang: () => uiLang.value });
const askActions: CardActions = {
  ...actions,
  ask: (question, event) => void sampleAsk.ask(question, event.isTrusted),
  cancelAsk: () => void sampleAsk.cancel(),
  seek: (atSec) => void ((window as unknown as { __seeked?: number }).__seeked = atSec),
};

function App() {
  const asking = location.hash === "#ask";
  return <Card view={view.value} aiReady={!keyCleared} setupHint={keyCleared ? cardSetupHint(KEY_CLEARED, uiLang.value) : ""} actions={asking ? askActions : actions} ask={asking ? sampleAsk.state.value : undefined} />;
}

/** 官方总结晚到多久。 */
const OFFICIAL_LATE_MS = 1_500;
const SAMPLE_REF = { platform: "bilibili", videoId: "BV1Sample001", segment: 1 } as const;
const SAMPLE_URL = "https://www.bilibili.com/video/BV1Sample001";

/** 官方总结晚到的卡片：模型原样用，后台的回复由这里现编。 */
function lateOfficial(root: HTMLElement, arrives: boolean, failed = false): void {
  const key = videoKey(SAMPLE_REF);
  const startedAt = performance.now();
  const arrived = (): boolean => arrives && performance.now() - startedAt >= OFFICIAL_LATE_MS;
  const listeners = new Set<Parameters<PageRuntime["onMessage"]["addListener"]>[0]>();
  const replies: Readonly<Record<string, () => unknown>> = {
    "session.get": () => ({ ok: true, value: { session: { video: key, mode: "skim", modeSource: "default", autoSwitched: false, playedSec: 0 } } }),
    "task.list": () => ({ ok: true, value: { tasks: [] } }),
    "transcript.get": () => failed ? { ok: false, code: "RATE_LIMITED" } : ({
      ok: true,
      value: {
        mode: "light",
        video: key,
        info: { title: "样例视频", author: "", description: "", durationSec: 1800 },
        official: arrived() ? { status: "ok", summary: SHORT_SUMMARY, outline: Array.from({ length: 3 }, (_, index) => ({ title: `样例小节 ${index + 1}`, timestamp: index * 60, points: [] })) } : { status: "pending", summary: "", outline: [] },
        hasTranscript: true,
        fromCache: true,
      },
    }),
  };
  const runtime: PageRuntime = {
    id: "card-sample",
    sendMessage: async (message) => replies[(message as { readonly type: string }).type]?.() ?? { ok: false, code: "UNKNOWN_ROUTE" },
    onMessage: { addListener: (listener) => void listeners.add(listener), removeListener: (listener) => void listeners.delete(listener) },
    connect: () => {
      throw new Error("样张不开长连接");
    },
  };
  if (arrives) setTimeout(() => listeners.forEach((listener) => listener({ type: "transcript.changed", video: key }, { id: runtime.id })), OFFICIAL_LATE_MS);
  const ready: ConfigState = { state: "checked", view: { ready: true, errors: [] } };
  const model = createCardModel({
    api: createPageApi({ runtime }),
    config: signal(ready),
    recheckConfig: async () => undefined,
    currentTab: async () => ({ id: 1, url: SAMPLE_URL, windowId: 1 }),
    parseVideo: (url) => (url === SAMPLE_URL ? SAMPLE_REF : null),
    seek: noop,
    lang: () => uiLang.value,
  });
  const live: CardActions = { ...actions, retry: model.retry, toggleShowAll: model.toggleShowAll, toggleOfficial: model.toggleOfficial, toggleComments: model.toggleComments };
  render(<LiveApp model={model} actions={live} />, root);
  model.configChanged();
  void model.start();
}

function LiveApp({ model, actions: live }: { readonly model: ReturnType<typeof createCardModel>; readonly actions: CardActions }) {
  return <Card view={model.view.value} aiReady={model.aiReady.value} setupHint="" actions={live} />;
}

// 界面语言照卡片入口那样定：先按首帧缓存，之后设置里的语言选项变了跟着换。别的外观由测试自己写，这里不接。
initUiLang();
bindDocumentLang(document, (lang) => cardTextOf(lang).title);
chrome.storage.onChanged.addListener((changes, area) => {
  const next: unknown = changes[SETTINGS_STORAGE_KEY]?.newValue;
  if (area === "local" && typeof next === "object" && next !== null) setUiLanguage((next as { readonly language?: unknown }).language);
});

const root = document.getElementById("app");
if (root && (location.hash === "#official-late" || location.hash === "#official-never" || location.hash === "#load-failed")) {
  lateOfficial(root, location.hash === "#official-late", location.hash === "#load-failed");
}
else if (root) render(<App />, root);
