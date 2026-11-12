// 侧边栏外壳：没确认启用时只有启用说明；没有视频时说明怎么用；有视频时是头部、一行提示和四个页签。
// 视频页没连上扩展、还没设置 AI 服务、字幕和视频对不上，都放在头部下面的一行提示里。
import { describe } from "../../core/errors.ts";
import { noticeLines, noticeStatus, ACTIVATION_TABLE } from "../../core/consent.ts";
import { ActivationNotice } from "../shared/ui/activation-notice.tsx";
import { activationSections } from "../shared/ui/activation.ts";
import { IconButton } from "../shared/ui/button.tsx";
import { rovingTarget } from "../shared/ui/keys.ts";
import { Menu, type MenuItem } from "../shared/ui/menu.tsx";
import { Notice } from "../shared/ui/notice.tsx";
import type { NoticeEntry } from "../shared/ui/notice.ts";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { NotesTab } from "./notes-tab.tsx";
import { OverviewTab } from "./overview-tab.tsx";
import type { Panel, TabId } from "./panel.ts";
import { QaTab } from "./qa-tab.tsx";
import { TranscriptTab } from "./transcript-tab.tsx";

const TABS: readonly { readonly id: TabId; readonly label: string }[] = [
  { id: "transcript", label: "字幕" },
  { id: "overview", label: "概览" },
  { id: "notes", label: "笔记" },
  { id: "qa", label: "问答" },
];

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
    </header>
  );
}

function Tabs({ panel }: { readonly panel: Panel }) {
  const selected = panel.tab.value;
  const onKeyDown = (event: KeyboardEvent): void => {
    const index = TABS.findIndex((item) => item.id === selected);
    const next = rovingTarget(event.key, index, TABS.length, "horizontal");
    if (next === null) return;
    event.preventDefault();
    const tab = TABS[next];
    if (!tab) return;
    panel.tab.value = tab.id;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`#tab-${tab.id}`)?.focus();
  };
  return (
    <div class="tabs" role="tablist" aria-label="侧边栏页签" onKeyDown={onKeyDown}>
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`tab-${id}`}
          class="tab"
          aria-selected={selected === id}
          aria-controls={`panel-${id}`}
          tabIndex={selected === id ? 0 : -1}
          onClick={() => (panel.tab.value = id)}
        >
          {label}
        </button>
      ))}
    </div>
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
  const tab = panel.tab.value;
  return (
    <main class="panel">
      <Header panel={panel} />
      <Notice notices={notices(panel)} />
      <Tabs panel={panel} />
      <section class="tab-panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "transcript" ? <TranscriptTab panel={panel} /> : null}
        {tab === "overview" ? <OverviewTab panel={panel} /> : null}
        {tab === "notes" ? <NotesTab panel={panel} /> : null}
        {tab === "qa" ? <QaTab panel={panel} /> : null}
      </section>
    </main>
  );
}
