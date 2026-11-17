// 侧边栏外壳：没确认启用时只有启用说明；没有视频时说明怎么用；有视频时是头部（含模式切换）、一行提示、
// 当前模式的内容（速览或精读）和底部工具条。问答抽屉和笔记层挂在最外面，切模式时不卸载，草稿和在途回答都留着。
// 视频页没连上扩展、还没设置 AI 服务、字幕和视频对不上、打开就出结论停着，都放在头部下面的一行提示里。
import { describe } from "../../core/errors.ts";
import { noticeLines, noticeStatus, ACTIVATION_TABLE } from "../../core/consent.ts";
import type { AutoPauseReason } from "../../shared/messages/ai.ts";
import { ActivationNotice } from "../shared/ui/activation-notice.tsx";
import { activationSections } from "../shared/ui/activation.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { Dock } from "../shared/ui/dock.tsx";
import { Menu, type MenuItem } from "../shared/ui/menu.tsx";
import { ModeSwitch } from "../shared/ui/mode-switch.tsx";
import { Notice } from "../shared/ui/notice.tsx";
import type { NoticeEntry } from "../shared/ui/notice.ts";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { Layer, Sheet } from "../shared/ui/overlay.tsx";
import { NotesTab } from "./notes-tab.tsx";
import type { Panel } from "./panel.ts";
import { QaTab } from "./qa-tab.tsx";
import { activeIndex } from "./reading.ts";
import { SkimView } from "./skim.tsx";
import { StudyView } from "./study.tsx";

const AUTO_PAUSED: Readonly<Record<AutoPauseReason, string>> = {
  quota: "额度用完，打开就出结论已暂停。手动生成成功一次，或在设置页关掉再打开就恢复",
  key: "密钥被拒，打开就出结论已暂停。手动生成成功一次，或在设置页关掉再打开就恢复",
};

const FULL_SECTIONS = (() => {
  const status = noticeStatus(ACTIVATION_TABLE, {});
  return activationSections(status.state === "needed" ? noticeLines(status.items) : []);
})();

function Activation({ panel }: { readonly panel: Panel }) {
  const view = panel.activation.view.value;
  if (view.state === "loading") return <p class="panel-loading">正在读取…</p>;
  if (view.state === "failed") {
    return <StateBlock title={describe(view.failure.code, view.failure.detail)} primary={{ label: "重试", onClick: () => void panel.activation.load() }} />;
  }
  if (view.state !== "needed") return null;
  const failure = panel.activation.confirmFailure.value;
  return (
    <ActivationNotice
      updated={view.updated}
      sections={activationSections(noticeLines(view.items))}
      fullSections={FULL_SECTIONS}
      phase={panel.activation.phase.value}
      {...(failure ? { error: describe(failure.code, failure.detail) } : {})}
      onConfirm={() => void panel.activation.confirm()}
    />
  );
}

function Header({ panel }: { readonly panel: Panel }) {
  const now = panel.transcript.state.value;
  const view = now.state === "ready" ? now.view : null;
  const failure = now.state === "failed" ? now.failure : null;
  const info = view?.info ?? failure?.info;
  const title = info?.title || failure?.tabTitle || panel.follow.target.value.title || "正在读取视频";
  const tracks = view?.tracks ?? [];
  const current = view?.transcript;
  const { tabId, video } = panel.follow.target.value;
  const items: MenuItem[] = tracks.map((track) => ({
    label: track.label,
    ...(track.trackId === current?.trackId ? { hint: "正在用" } : {}),
    onSelect: () => {
      if (video && track.trackId !== current?.trackId) void panel.transcript.load(video, tabId, { lang: track.lang });
    },
  }));
  return (
    <header class="panel-head">
      <div class="panel-head-row">
        <h1 class="video-title" title={title}>
          {title}
        </h1>
        <IconButton icon="settings" label="打开设置" onClick={panel.openOptions} />
      </div>
      <div class="video-meta">
        {info?.author ? <span>{info.author}</span> : null}
        {current ? (
          tracks.length > 1 ? (
            <Menu label="换字幕语言" icon="chevron" text={current.fileName ? `导入：${current.fileName}` : current.label} items={items} />
          ) : (
            <span class="meta-chip">{current.fileName ? `导入：${current.fileName}` : current.label}</span>
          )
        ) : null}
      </div>
      <div class="mode-row">
        <ModeSwitch value={panel.mode.view.value.mode} onChange={(mode) => void panel.chooseMode(mode)} />
        <IconButton icon="note" label="笔记" onClick={() => (panel.notesOpen.value = true)} />
      </div>
    </header>
  );
}

/** 底部工具条：提问入口两种模式都在同一个位置，只打开抽屉；精读多一个「存笔记」，记下播放到的这一句。 */
function Toolbar({ panel }: { readonly panel: Panel }) {
  const study = panel.mode.view.value.mode === "study";
  const saveNote = async (): Promise<void> => {
    const { video } = panel.follow.target.peek();
    const position = panel.player.position.peek();
    if (!video || !position || position.video !== video) return panel.say("还不知道播放到哪，等视频页连上简幕再记");
    const now = panel.transcript.state.peek();
    const segments = now.state === "ready" ? now.view.transcript.segments : [];
    const line = segments[activeIndex(segments, position.atSec)]?.text ?? "";
    panel.say(await panel.notes.save(position.atSec, line));
  };
  return (
    <Dock>
      <button type="button" class="ask-entry" aria-haspopup="dialog" onClick={() => (panel.qaOpen.value = true)}>
        针对这个视频提问
      </button>
      {study ? (
        <Button variant="text" onClick={() => void saveNote()}>
          存笔记
        </Button>
      ) : null}
    </Dock>
  );
}

function notices(panel: Panel): (NoticeEntry | null)[] {
  const { tabId } = panel.follow.target.value;
  const toast = panel.toast.value;
  const unreachable = panel.player.connected.value === false || (tabId !== null && panel.activation.unreachableTabs.value.includes(tabId));
  const config = panel.config.state.value;
  const now = panel.transcript.state.value;
  return [
    toast ? { id: `toast-${toast.id}`, priority: 0, text: toast.text, tone: "accent" } : null,
    unreachable && tabId !== null
      ? {
          id: "connect",
          priority: 1,
          text: "视频页还没连上简幕，刷新后才能跳转和跟着播放滚动",
          tone: "warn",
          action: { label: "刷新视频页", run: () => void chrome.tabs.reload(tabId).catch(() => undefined) },
        }
      : null,
    now.state === "ready" && now.view.subtitleMismatch ? { id: "mismatch", priority: 2, text: describe("SUBTITLE_MISMATCH"), tone: "warn" } : null,
    config.state === "checked" && !config.view.ready
      ? { id: "config", priority: 3, text: "字幕不用设置就能看；概览和问答要先设置 AI 服务", tone: "plain", action: { label: "打开设置", run: panel.openOptions } }
      : null,
    config.state === "checked" && config.view.autoPaused
      ? { id: "auto-paused", priority: 4, text: AUTO_PAUSED[config.view.autoPaused], tone: "warn", action: { label: "打开设置", run: panel.openOptions } }
      : null,
  ];
}

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
        <Notice notices={[panel.toast.value ? { id: "toast", priority: 0, text: panel.toast.value.text, tone: "accent" } : null]} />
        <StateBlock title="打开一个 B 站视频" impact="在 B 站的视频播放页打开侧边栏，就能读字幕、生成概览、提问和记笔记。" />
      </main>
    );
  }
  const mode = panel.mode.view.value.mode;
  return (
    <main class="panel" data-mode={mode}>
      <Header panel={panel} />
      <Notice notices={notices(panel)} />
      <section class="mode-view" aria-label={mode === "study" ? "精读" : "速览"}>
        {mode === "study" ? <StudyView panel={panel} /> : <SkimView panel={panel} />}
      </section>
      <Toolbar panel={panel} />
      <Sheet open={panel.qaOpen.value} title="问答" onClose={() => (panel.qaOpen.value = false)}>
        <QaTab panel={panel} />
      </Sheet>
      <Layer open={panel.notesOpen.value} title="笔记" onClose={() => (panel.notesOpen.value = false)}>
        {panel.notesOpen.value ? <NotesTab panel={panel} /> : null}
      </Layer>
    </main>
  );
}
