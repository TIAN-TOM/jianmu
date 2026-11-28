// 字幕列表：精读的主体，速读里还没有概览时也摆在下面。逐段字幕，点一段跳到那里，跟着播放位置滚动；搜索高亮、换原文译文双语、导入导出字幕文件。
// 读不到字幕时说明原因，视频网站给的导读照样摆出来；选中一段文字可以请模型解释。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { lineBreaks, splitRuns } from "../../core/transcript/lines.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { TranscriptView } from "../../shared/messages/transcript.ts";
import { canStartTranslation } from "./translate.ts";
import { readsOnClick } from "./transcript.ts";
import { openReadHint } from "./open-transcript.ts";

const manualReadHint = (lang: UiLang): string => panelTextOf(lang).transcript.manualReadHint;
// 关掉代开开关的构建里没有代开文字稿，说明让用户自己打开。
const readHint = FEATURE_YOUTUBE_OPEN_PANEL ? openReadHint : manualReadHint;
import { Button, IconButton } from "../shared/ui/button.tsx";
import { Icon } from "../shared/ui/icon.tsx";
import { Menu, type MenuItem } from "../shared/ui/menu.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { Sheet } from "../shared/ui/overlay.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { stateCopy } from "../shared/ui/state.ts";
import { downloadFile } from "../shared/download.ts";
import { safeFileName } from "./files.ts";
import { copyText } from "./copy.ts";
import { CreatorChapters, OfficialSummary } from "./guides.tsx";
import type { Panel } from "./panel.ts";
import { SettingsExit } from "./settings-exit.tsx";
import { activeIndex, copyTextOf, noteSegmentIndex, explainable, mainBreaks, refreshLang, selectedNote, srtOf, transcriptRows } from "./reading.ts";
import { needsSetup, setupReason } from "../shared/config.ts";
import { uiLang, type UiLang } from "../shared/ui-lang.ts";
import { sharedText } from "../shared/text.ts";
import { panelText, panelTextOf } from "./text.ts";

function Highlighted({ text, query, breaks = [] }: { readonly text: string; readonly query: string; readonly breaks?: readonly number[] }) {
  const parts = splitMatches(text, query);
  const runs = (list: readonly { readonly text: string; readonly hit: boolean }[]) =>
    list.map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>));
  // 没有标点的段落按原始字幕的行分开显示；拼起来的文字和原文一字不差，选中、复制、搜索都照旧。
  if (breaks.length) {
    return (
      <>
        {splitRuns(parts, breaks).map((line, index) => (
          <span key={index} class="cue-line">
            {runs(line)}
          </span>
        ))}
      </>
    );
  }
  if (!hasMatch(parts)) return <>{text}</>;
  return <>{runs(parts)}</>;
}

function ImportInput({ panel, inputRef }: { readonly panel: Panel; readonly inputRef: { current: HTMLInputElement | null } }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".srt,.vtt"
      hidden
      onChange={(event) => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = "";
        if (file) void panel.transcript.importFile(file).then(panel.say);
      }}
    />
  );
}

function ExplainSheet({ panel }: { readonly panel: Panel }) {
  const explain = panel.qa.explain.value;
  const open = explain.phase !== "idle";
  const t = panelText().transcript;
  return (
    <Sheet open={open} title={explain.selection ? t.explainTitle(explain.selection) : t.explain} onClose={() => panel.qa.closeExplain()}>
      <p class="explain-body" data-phase={explain.phase} aria-live="polite">
        {explain.phase === "running" ? t.explaining : explain.text}
      </p>
      {explain.phase === "failed" ? <ServiceSaid said={explain.said} /> : null}
    </Sheet>
  );
}

function Toolbar({ panel, view, onSearch, searching, onImport }: { readonly panel: Panel; readonly view: TranscriptView; readonly onSearch: () => void; readonly searching: boolean; readonly onImport: () => void }) {
  const { translation, transcript, follow } = panel;
  const mode = translation.mode.value;
  const position = panel.player.position.value;
  const p = panelText();
  const t = p.transcript;
  const modeLabel = t.modes;
  const hasWork = mode !== "original" && canStartTranslation(translation.state.value) && view.transcript.segments.some(({ id }) => !translation.lines.value[id]);
  const currentHint = hasWork ? t.translateHint : p.inUse;
  const modeItems: MenuItem[] = (["original", "translated", "bilingual"] as const).map((item) => ({
    label: modeLabel[item],
    ...(item === mode ? { hint: currentHint } : item !== "original" ? { hint: t.translateHint } : {}),
    onSelect: () => translation.setMode(item, position?.atSec),
  }));
  const exportSrt = (): void => {
    const text = srtOf(view.transcript.segments, view.transcript.cues, view.info.durationSec, mode, translation.lines.peek(), tidiedOf(panel));
    downloadFile(`${safeFileName(view.info.title, t.file)}.srt`, [text], "application/x-subrip;charset=utf-8");
  };
  const copyAll = (): void => {
    const text = copyTextOf(view.transcript.segments, mode, translation.lines.peek(), tidiedOf(panel));
    void copyText(panel, text, t.copied);
  };
  const moreItems: MenuItem[] = [
    {
      label: t.reload,
      hint: t.reloadHint,
      // 导入的字幕不点名语言：点名语言会改读平台的字幕轨，绕过导入的文件。官方总结附带的字幕不是平台列出的哪一条轨，也不点名。
      // YouTube 读的是面板当前显示的那一轨，用户可能在面板里换过语言：不点名上次的语言。
      onSelect: () =>
        void transcript.load(view.video, follow.target.peek().tabId, { ...(refreshLang(view.transcript) && !readsOnClick(view.video) ? { lang: view.transcript.ref.lang } : {}), fresh: true }),
    },
    { label: t.copyAll, onSelect: copyAll },
    { label: t.exportSrt, hint: t.exportSrtHint(modeLabel[mode]), onSelect: exportSrt },
    { label: t.importFile, hint: t.importHint, onSelect: onImport },
    ...(view.transcript.fileName ? [{ label: t.removeImport, hint: t.removeImportHint, onSelect: () => void transcript.removeImport().then(panel.say) }] : []),
  ];
  return (
    <div class="toolbar">
      <span class="toolbar-count">{t.segments(view.transcript.segments.length)}</span>
      <span class="toolbar-actions">
        <Menu label={t.view} icon="chevron" text={modeLabel[mode]} items={modeItems} />
        <IconButton icon="search" label={t.search} pressed={searching} onClick={onSearch} />
        <Menu label={t.more} items={moreItems} />
      </span>
    </div>
  );
}

const NO_LINES: Readonly<Record<string, string>> = {};

/** 当前句离屏幕正中不到一屏半时滑过去，再远就直接跳：滑一长段既慢又晃眼。 */
function followBehavior(node: Element): ScrollBehavior {
  const view = node.ownerDocument.defaultView;
  if (!view || view.matchMedia("(prefers-reduced-motion: reduce)").matches) return "instant";
  const box = node.getBoundingClientRect();
  return Math.abs(box.top + box.height / 2 - view.innerHeight / 2) < view.innerHeight * 1.5 ? "smooth" : "instant";
}

/** 正在显示的整理结果：用户切回原始字幕时不给。 */
const tidiedOf = (panel: Panel): Readonly<Record<string, string>> => (panel.tidy.show.peek() ? panel.tidy.lines.peek() : NO_LINES);

/**
 * 整理字幕那一行：没整理过时是按钮，写明要花额度；整理中显示进度和停止；整理过以后能在整理后和原始字幕之间切换，
 * 没整理完的可以接着整理。只在用户点的时候做，不自动做。AI 服务没设置好时先不摆这两个按钮，顶上那一行带人去设置。
 */
function TidyRow({ panel, segments }: { readonly panel: Panel; readonly segments: number }) {
  const { phase, done, total, message, said, code } = panel.tidy.state.value;
  const count = Object.keys(panel.tidy.lines.value).length;
  const show = panel.tidy.show.value;
  const p = panelText();
  const t = p.transcript;
  const start = (): void => {
    const position = panel.player.position.peek();
    panel.tidy.start(position?.atSec);
  };
  if (phase === "running") {
    return (
      <div class="progress-row" role="status">
        <span>{total > 0 ? t.tidying(done, total) : t.tidyingPlain}</span>
        <Button variant="text" onClick={() => panel.tidy.stopRunning()}>
          {p.stop}
        </Button>
      </div>
    );
  }
  const config = panel.config.state.value;
  const ready = config.state === "checked" && config.view.ready;
  const reason = ready ? undefined : setupReason(config, uiLang.value);
  const offer = !needsSetup(config);
  if (count === 0 && !offer && !message) return null;
  return (
    <div class="tidy-row">
      {count === 0 ? (
        offer ? (
          <Button onClick={start} disabled={!ready} {...(reason ? { disabledReason: reason } : {})} note={t.tidyNote}>
            {t.tidy}
          </Button>
        ) : null
      ) : (
        <>
          <Button variant="text" onClick={() => panel.tidy.setShow(!show)}>
            {show ? t.showOriginal : t.showTidied}
          </Button>
          {count < segments && offer ? (
            <Button variant="text" onClick={start} disabled={!ready} {...(reason ? { disabledReason: reason } : {})} note={t.tidyNote}>
              {t.continueTidy}
            </Button>
          ) : null}
        </>
      )}
      {message ? <p class="note-line">{message}</p> : null}
      {message ? <ServiceSaid said={said} /> : null}
      {message ? <SettingsExit panel={panel} code={code} /> : null}
    </div>
  );
}

/** 翻译那一行：翻译中显示进度和停止；停了、没译完或出错时说一句，还有没译的段就给「接着翻译」，从播放到的地方接着译。 */
function TranslateRow({ panel, view }: { readonly panel: Panel; readonly view: TranscriptView }) {
  const state = panel.translation.state.value;
  const { phase, done, total, message, said, code } = state;
  const mode = panel.translation.mode.value;
  const p = panelText();
  if (mode === "original" && phase !== "running") return null;
  if (phase === "running") {
    return (
      <div class="progress-row" role="status">
        <span>{total > 0 ? p.transcript.translating(done, total) : p.transcript.translatingPlain}</span>
        <Button variant="text" onClick={() => panel.translation.stopRunning()}>
          {p.stop}
        </Button>
      </div>
    );
  }
  const lines = panel.translation.lines.value;
  const more = canStartTranslation(state) && !needsSetup(panel.config.state.value) && view.transcript.segments.some(({ id }) => !lines[id]);
  // 停下的说明只在这次打开里有；关掉侧边栏再开，显示方式还在、有没译的段时照样给「接着翻译」。点了花额度，旁边写明。
  const text = message || (more ? p.transcript.translateUnfinished : "");
  if (!text) return null;
  return (
    <>
      <div class="progress-row" role="status">
        <span>{text}</span>
        {more ? (
          <Button variant="text" note={p.transcript.translateHint} onClick={() => panel.translation.setMode(mode, panel.player.position.peek()?.atSec)}>
            {p.transcript.continueTranslate}
          </Button>
        ) : null}
      </div>
      {message ? <ServiceSaid said={said} /> : null}
      {message ? <SettingsExit panel={panel} code={code} /> : null}
    </>
  );
}

function Ready({ panel, view, follow }: { readonly panel: Panel; readonly view: TranscriptView; readonly follow: boolean }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [following, setFollowing] = useState(follow);
  const [pick, setPick] = useState<{ readonly text: string; readonly atSec: number; readonly context: string; readonly top: number } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const segments = view.transcript.segments;
  // 每段按原始字幕的哪几处断开：只看这一份字幕，换版本时整个列表重建。
  const breaks = useMemo(() => lineBreaks(segments, view.transcript.cues), [segments, view.transcript.cues]);
  const mode = panel.translation.mode.value;
  const translated = panel.translation.lines.value;
  const tidied = panel.tidy.lines.value;
  const showTidied = panel.tidy.show.value;
  const position = panel.player.position.value;
  const at = position?.video === view.video ? position.atSec : null;
  const active = activeIndex(segments, at);
  const needle = query.trim();
  const p = panelText();
  const t = p.transcript;
  const jumpTo = sharedText().jumpTo;
  const shown = useMemo(() => transcriptRows(segments, mode, translated, tidied, showTidied, needle), [segments, mode, translated, tidied, showTidied, needle]);
  // 存过笔记的那几句：有的主题把它们用荧光笔划出来。
  const notes = panel.notes.state.value;
  const saved = useMemo(
    () => new Set(notes.scope === "video" && notes.video === view.video ? notes.notes.map((note) => noteSegmentIndex(segments, note.atSec)) : []),
    [notes, segments, view.video],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role='textbox'], dialog[open], [role='menu']"))) return;
      event.preventDefault();
      setSearching(true);
      searchInput.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);

  // 别处要把视野留给别的内容：停下跟随，「回到当前句」接着能点回来。
  const hold = panel.followHold.value;
  const holdAtStart = useRef(hold);
  useEffect(() => {
    if (hold !== holdAtStart.current) setFollowing(false);
  }, [hold]);

  // 跟着播放滚：下一句就在附近时滑过去，看得出是往下走了一句；刚进来、隔得远（拖了进度条）或者系统要求减少动态效果时直接到位。
  const settled = useRef(false);
  useEffect(() => {
    if (!following || needle || active < 0) return;
    const node = list.current?.querySelector(`[data-index="${active}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: settled.current ? followBehavior(node) : "instant" });
    settled.current = true;
  }, [active, following, needle]);

  const onSelectEnd = (): void => {
    const selection = getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const listNode = list.current;
    if (!range || !listNode?.contains(range.commonAncestorContainer)) return setPick(null);
    const cueOf = (node: Node): HTMLElement | null =>
      (node instanceof Element ? node : node.parentElement)?.closest(".cue-text, .cue-sub")?.closest<HTMLElement>(".cue") ?? null;
    const first = cueOf(range.startContainer);
    if (!first || !cueOf(range.endContainer)) return setPick(null);
    const note = selectedNote(selection?.toString() ?? "", segments[Number(first.dataset.index)]);
    if (!note) return setPick(null);
    const top = range.getBoundingClientRect().bottom - listNode.getBoundingClientRect().top + listNode.scrollTop;
    setPick({ ...note, context: first.querySelector(".cue-text")?.textContent ?? "", top });
  };

  return (
    <>
      {/* 工具行、搜索框和翻译进度：精读里吸在当前章节下面。 */}
      <div class="cue-tools">
        <Toolbar panel={panel} view={view} searching={searching} onSearch={() => { setSearching(!searching); setQuery(""); }} onImport={() => fileInput.current?.click()} />
        <ImportInput panel={panel} inputRef={fileInput} />
        {searching ? (
          <div class="search-row">
            <input
              ref={searchInput}
              class="search-input"
              type="search"
              placeholder={t.searchPlaceholder}
              aria-label={t.search}
              value={query}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.isComposing) {
                  event.preventDefault();
                  setQuery("");
                  setSearching(false);
                }
              }}
            />
            <span class="search-count">{needle ? t.matches(shown.length) : ""}</span>
          </div>
        ) : null}
        <TranslateRow panel={panel} view={view} />
      </div>
      <TidyRow panel={panel} segments={segments.length} />
      <ol class="cues" ref={list} onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onMouseUp={onSelectEnd} onKeyUp={onSelectEnd}>
        {shown.map(({ segment, index, main, sub, extra }) => (
          <li key={segment.id} class="cue" data-index={index} data-active={index === active ? "true" : undefined} data-saved={saved.has(index) ? "true" : undefined}>
            <button type="button" class="cue-time" aria-label={jumpTo(formatTimestamp(segment.start))} onClick={() => void panel.seek(segment.start)}>
              {formatTimestamp(segment.start)}
            </button>
            <p class="cue-text">
              <Highlighted text={main} query={needle} breaks={mainBreaks(segment, main, breaks)} />
            </p>
            {sub ? (
              <p class="cue-sub">
                <Highlighted text={sub} query={needle} />
              </p>
            ) : null}
            {extra.map((line) => (
              <p key={line} class="cue-sub">
                <Highlighted text={line} query={needle} />
              </p>
            ))}
          </li>
        ))}
        {pick ? (
          <li class="explain-pick" style={{ top: `${pick.top}px` }} onMouseUp={(event) => event.stopPropagation()} onKeyUp={(event) => event.stopPropagation()}>
            {explainable(pick.text) ? (
              <Button variant="primary" onClick={() => { setPick(null); void panel.qa.explainSelection(pick.text, pick.context); }}>
                {t.explain}
              </Button>
            ) : null}
            <Button onClick={() => {
              setPick(null);
              if (panel.notes.state.peek().video === view.video) void panel.notes.save(pick.atSec, pick.text).then(panel.say);
            }}>
              {p.dock.saveNote}
            </Button>
          </li>
        ) : null}
      </ol>
      {needle && shown.length === 0 ? <p class="empty-line">{p.notFound(needle)}</p> : null}
      {/* 一直挂着、用 data-shown 显隐：离开当前句时从底下浮上来，点了或者又跟上时沉下去。藏着时不进 Tab 顺序也不进读屏。 */}
      <button type="button" class="follow-pill" data-shown={!following && at !== null ? "true" : undefined} inert={following || at === null} onClick={() => setFollowing(true)}>
        <Icon name="target" />
        <span>{t.backToCurrent}</span>
      </button>
      <ExplainSheet panel={panel} />
    </>
  );
}

/** guides 为 false 时读不到字幕也不再摆官方总结和 UP 主分段：外面已经摆了。follow 为 false 时一开始不跟着播放滚动，点「回到当前句」才跟。 */
export function TranscriptTab({ panel, guides = true, follow = true }: { readonly panel: Panel; readonly guides?: boolean; readonly follow?: boolean }) {
  const now = panel.transcript.state.value;
  const fileInput = useRef<HTMLInputElement>(null);
  const p = panelText();
  const t = p.transcript;
  if (now.state === "idle" || now.state === "loading") {
    return (
      <div class="loading" role="status">
        <p class="loading-title">{t.loading}</p>
        <span class="ske-line" />
        <span class="ske-line" />
        <span class="ske-line" />
      </div>
    );
  }
  if (now.state === "failed" && now.failure.code === "NOT_CACHED" && readsOnClick(now.video)) {
    const { video } = now;
    // YouTube 不自动读：用户先在视频页上打开文字稿，再点这里。
    return (
      <>
        <StateBlock
          title={t.readTitle}
          impact={readHint(uiLang.value)}
          primary={{ label: t.read, onClick: () => void panel.transcript.load(video, panel.follow.target.peek().tabId) }}
          secondary={[{ label: t.importFile, onClick: () => fileInput.current?.click() }]}
        />
        <ImportInput panel={panel} inputRef={fileInput} />
      </>
    );
  }
  if (now.state === "failed") {
    const { failure, video } = now;
    const copy = stateCopy(failure.code, failure.detail, uiLang.value);
    const guided = guides && failure.official?.status === "ok";
    return (
      <>
        <StateBlock
          {...copy}
          {...(guided ? { impact: t.guided(copy.impact ?? "") } : {})}
          primary={{ label: p.retry, onClick: () => void panel.transcript.load(video, panel.follow.target.peek().tabId, { fresh: true }) }}
          secondary={[{ label: t.importFile, onClick: () => fileInput.current?.click() }]}
        />
        <ImportInput panel={panel} inputRef={fileInput} />
        {guides ? <OfficialSummary official={failure.official} onSeek={(at) => void panel.seek(at)} /> : null}
        {guides ? <CreatorChapters chapters={failure.chapters} onSeek={(at) => void panel.seek(at)} /> : null}
      </>
    );
  }
  return <Ready key={`${now.video}/${now.view.transcript.ref.fingerprint}`} panel={panel} view={now.view} follow={follow} />;
}
