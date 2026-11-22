// 侧边栏外壳：没确认启用时只有启用说明；没有视频时说明怎么用；有视频时是头部（含模式切换）、一行提示、
// 当前模式的内容（速览或精读）和底部工具条（提问框在最左）。问答抽屉和笔记层挂在最外面，切模式时不卸载，草稿和在途回答都留着。
// 视频页没连上扩展、还没设置 AI 服务、字幕和视频对不上、打开就出结论停着，都放在头部下面的一行提示里。
import { describe, errorCopy } from "../../core/errors.ts";
import { translatedTitleOf } from "../../core/ai/verdict.ts";
import { noticeLines, noticeStatus, ACTIVATION_TABLE } from "../../core/consent.ts";
import { ActivationNotice } from "../shared/ui/activation-notice.tsx";
import { carriedList, carriedNotice } from "./carried.tsx";
import { activationSections } from "../shared/ui/activation.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { Dock } from "../shared/ui/dock.tsx";
import { Menu, type MenuItem } from "../shared/ui/menu.tsx";
import { ModeSwitch } from "../shared/ui/mode-switch.tsx";
import { Notice } from "../shared/ui/notice.tsx";
import { pickNotice, type NoticeEntry } from "../shared/ui/notice.ts";
import { useEffect, useState } from "preact/hooks";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { stateCopy } from "../shared/ui/state.ts";
import { Layer, Sheet } from "../shared/ui/overlay.tsx";
import { NotesTab } from "./notes-tab.tsx";
import type { Panel } from "./panel.ts";
import { askReason, canSend, QaTab } from "./qa-tab.tsx";
import { activeIndex } from "./reading.ts";
import { SkimView } from "./skim.tsx";
import { StudyView } from "./study.tsx";
import { trackLabel } from "./files.ts";
import { FrameButton, FrameResults } from "./frame-view.tsx";
import { YoutubeNoVideo } from "./youtube-gate.tsx";
import { setupNotice } from "../shared/config.ts";
import { sharedText } from "../shared/text.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { panelText } from "./text.ts";

/** 说明更新时可以展开看的完整说明。 */
function fullSections() {
  const status = noticeStatus(ACTIVATION_TABLE, {});
  return activationSections(status.state === "needed" ? noticeLines(status.items, uiLang.value) : [], uiLang.value);
}

function Activation({ panel }: { readonly panel: Panel }) {
  const view = panel.activation.view.value;
  const t = panelText();
  if (view.state === "loading") return <p class="panel-loading">{t.loading}</p>;
  if (view.state === "failed") {
    return <StateBlock {...stateCopy(view.failure.code, view.failure.detail, uiLang.value)} primary={{ label: t.retry, onClick: () => void panel.activation.load() }} />;
  }
  if (view.state !== "needed") return null;
  const failure = panel.activation.confirmFailure.value;
  return (
    <ActivationNotice
      updated={view.updated}
      sections={activationSections(noticeLines(view.items, uiLang.value), uiLang.value)}
      fullSections={fullSections()}
      phase={panel.activation.phase.value}
      {...(failure ? { error: describe(failure.code, failure.detail, uiLang.value) } : {})}
      onConfirm={() => void panel.activation.confirm()}
    />
  );
}

function Header({ panel }: { readonly panel: Panel }) {
  const now = panel.transcript.state.value;
  const view = now.state === "ready" ? now.view : null;
  const failure = now.state === "failed" ? now.failure : null;
  const info = view?.info ?? failure?.info;
  const t = panelText();
  const { tabId, video } = panel.follow.target.value;
  const original = info?.title || failure?.tabTitle || panel.follow.target.value.title || "";
  // 当前这份概览的结论带着标题译名时显示译名，悬停看原标题；没有译名就是原标题。
  const overview = panel.overview.state.value;
  const translated = overview.video === video ? translatedTitleOf(overview.saved?.analysis.verdict?.translatedTitle, original) : "";
  const title = translated || original || t.head.loadingVideo;
  const tracks = view?.tracks ?? [];
  const current = view?.transcript;
  const items: MenuItem[] = tracks.map((track) => ({
    label: trackLabel(current?.ref.video ?? video, track, uiLang.value),
    ...(track.trackId === current?.trackId ? { hint: t.inUse } : {}),
    onSelect: () => {
      if (video && track.trackId !== current?.trackId) void panel.transcript.load(video, tabId, { lang: track.lang });
    },
  }));
  return (
    <header class="panel-head">
      <div class="panel-head-row">
        <h1 class="video-title" title={translated ? original : title}>
          {title}
        </h1>
        <IconButton icon="settings" label={t.openSettings} onClick={panel.openOptions} />
      </div>
      <div class="video-meta">
        {info?.author ? <span>{info.author}</span> : null}
        {current ? (
          tracks.length > 1 ? (
            <Menu label={t.head.switchTrack} icon="chevron" text={current.fileName ? t.head.imported(current.fileName) : trackLabel(current.ref.video, current, uiLang.value)} items={items} />
          ) : (
            <span class="meta-chip">{current.fileName ? t.head.imported(current.fileName) : trackLabel(current.ref.video, current, uiLang.value)}</span>
          )
        ) : null}
      </div>
    </header>
  );
}

/** 模式切换和笔记按钮：放在头部外面，滚动时吸在顶上。 */
function ModeRow({ panel }: { readonly panel: Panel }) {
  return (
    <div class="mode-row">
      <ModeSwitch value={panel.mode.view.value.mode} onChange={(mode) => void panel.chooseMode(mode)} />
      <IconButton icon="note" label={panelText().head.notes} onClick={() => (panel.notesOpen.value = true)} />
    </div>
  );
}

/**
 * 底部的提问框：回车发出问题、清空，打开问答抽屉看回答。不能问时不发，字留着，照样打开抽屉，原因在抽屉里的提问按钮旁边。
 * 空着回车或点旁边的按钮只打开抽屉看历史。用表单提交，输入法选字时的回车不算。
 */
function AskBox({ panel }: { readonly panel: Panel }) {
  const [question, setQuestion] = useState("");
  const t = panelText();
  const open = (): void => {
    panel.qaOpen.value = true;
  };
  const submit = (event: Event): void => {
    event.preventDefault();
    if (canSend(askReason(panel), question)) {
      void panel.qa.ask(question);
      setQuestion("");
    }
    open();
  };
  return (
    <>
      <form class="ask-entry" onSubmit={submit}>
        <input class="search-input" type="text" aria-label={t.dock.ask} placeholder={t.qa.placeholder} value={question} onInput={(event) => setQuestion(event.currentTarget.value)} />
      </form>
      <IconButton icon="task" label={t.dock.history} onClick={open} />
    </>
  );
}

/** 底部工具条：提问框两种模式都在同一个位置；精读多一个「存笔记」，记下播放到的这一句。 */
function Toolbar({ panel }: { readonly panel: Panel }) {
  const study = panel.mode.view.value.mode === "study";
  const t = panelText().dock;
  const saveNote = async (): Promise<void> => {
    const { video } = panel.follow.target.peek();
    const position = panel.player.position.peek();
    if (!video || !position || position.video !== video) return panel.say(panelText().dock.noPosition);
    const now = panel.transcript.state.peek();
    const segments = now.state === "ready" ? now.view.transcript.segments : [];
    const line = segments[activeIndex(segments, position.atSec)]?.text ?? "";
    panel.say(await panel.notes.save(position.atSec, line));
  };
  return (
    <Dock>
      <AskBox panel={panel} />
      {study ? (
        <Button variant="text" onClick={() => void saveNote()}>
          {t.saveNote}
        </Button>
      ) : null}
      {FEATURE_FRAME_EXPLAIN && study && panel.frame ? <FrameButton panel={panel} frame={panel.frame} /> : null}
    </Dock>
  );
}

const AUTO_SWITCHED = "auto-switched";

function notices(panel: Panel): (NoticeEntry | null)[] {
  const { tabId } = panel.follow.target.value;
  const toast = panel.toast.value;
  const unreachable = panel.player.connected.value === false || (tabId !== null && panel.activation.unreachableTabs.value.includes(tabId));
  const config = panel.config.state.value;
  const now = panel.transcript.state.value;
  const p = panelText();
  const t = p.notices;
  return [
    toast ? { id: `toast-${toast.id}`, priority: 0, text: toast.text, tone: "accent" } : null,
    unreachable && tabId !== null
      ? {
          id: "connect",
          priority: 1,
          text: t.connect,
          tone: "warn",
          action: { label: t.reloadPage, run: () => void chrome.tabs.reload(tabId).catch(() => undefined) },
        }
      : null,
    panel.undoLine.shown.value
      ? { id: AUTO_SWITCHED, priority: 1.5, text: t.switchedToStudy, tone: "accent", action: { label: t.backToSkim, run: () => void panel.mode.undo() } }
      : null,
    now.state === "ready" && now.view.subtitleMismatch ? { id: "mismatch", priority: 2, text: errorCopy("SUBTITLE_MISMATCH", undefined, uiLang.value).cause, tone: "warn" } : null,
    config.state === "checked" && !config.view.ready
      ? { id: "config", priority: 3, text: setupNotice(config, uiLang.value), tone: "plain", action: { label: p.openSettings, run: () => panel.openSettingsAt("ai-service") } }
      : null,
    FEATURE_KEEP_CONSENT ? carriedNotice(panel) : null,
    config.state === "checked" && config.view.autoPaused
      ? { id: "auto-paused", priority: 4, text: t.autoPaused[config.view.autoPaused], tone: "warn", action: { label: p.openSettings, run: panel.openOptions } }
      : null,
  ];
}

/** 「已切到精读」只在看得见、点得到时计时：显示的正是这一行，侧边栏在前台，没被抽屉、层或划词解释盖住。 */
function UndoClock({ panel, shown }: { readonly panel: Panel; readonly shown: boolean }) {
  const counting = shown && panel.pageVisible.value && !panel.qaOpen.value && !panel.notesOpen.value && panel.qa.explain.value.phase === "idle";
  useEffect(() => panel.undoLine.setCounting(counting), [counting]);
  useEffect(() => () => panel.undoLine.setCounting(false), []);
  return null;
}

function BilibiliNoVideo(_props: { readonly panel: Panel }) {
  const t = panelText().noVideo;
  return <StateBlock title={t.title} impact={t.impact} />;
}

// 关掉 YouTube 开关的构建里 YouTube 那一份连同授权按钮一起裁掉。
const NoVideo = FEATURE_YOUTUBE ? YoutubeNoVideo : BilibiliNoVideo;

export function App({ panel }: { readonly panel: Panel }) {
  if (!panel.activation.enabled.value) {
    return (
      <main class="panel panel-gate">
        <Activation panel={panel} />
      </main>
    );
  }
  const { video } = panel.follow.target.value;
  if (!video) {
    return (
      <main class="panel panel-gate">
        <Notice notices={[panel.toast.value ? { id: "toast", priority: 0, text: panel.toast.value.text, tone: "accent" } : null, FEATURE_KEEP_CONSENT ? carriedNotice(panel) : null]} />
        {FEATURE_KEEP_CONSENT ? carriedList(panel) : null}
        <NoVideo panel={panel} />
      </main>
    );
  }
  const mode = panel.mode.view.value.mode;
  const lines = notices(panel);
  return (
    <main class="panel" data-mode={mode}>
      <UndoClock panel={panel} shown={pickNotice(lines)?.id === AUTO_SWITCHED} />
      <Header panel={panel} />
      <ModeRow panel={panel} />
      <Notice notices={lines} />
      {FEATURE_KEEP_CONSENT ? carriedList(panel) : null}
      {FEATURE_FRAME_EXPLAIN && panel.frame ? <FrameResults panel={panel} frame={panel.frame} /> : null}
      <section class="mode-view" aria-label={sharedText().modes[mode]}>
        {mode === "study" ? <StudyView panel={panel} /> : <SkimView panel={panel} />}
      </section>
      <Toolbar panel={panel} />
      <Sheet open={panel.qaOpen.value} title={panelText().qa.title} onClose={() => (panel.qaOpen.value = false)}>
        <QaTab panel={panel} />
      </Sheet>
      <Layer open={panel.notesOpen.value} title={panelText().head.notes} onClose={() => (panel.notesOpen.value = false)}>
        {/* 层盖住了顶上那一行提示：改笔记、删笔记的结果在层里说。 */}
        {panel.notesOpen.value && panel.toast.value ? (
          <p class="layer-toast" role="status">
            {panel.toast.value.text}
          </p>
        ) : null}
        {panel.notesOpen.value ? <NotesTab panel={panel} /> : null}
      </Layer>
    </main>
  );
}
