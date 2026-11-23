// 字幕列表：精读的主体，速读里还没有概览时也摆在下面。逐段字幕，点一段跳到那里，跟着播放位置滚动；搜索高亮、换原文译文双语、导入导出字幕文件。
// 读不到字幕时说明原因，视频网站给的导读照样摆出来；选中一段文字可以请模型解释。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { lineBreaks, splitRuns } from "../../core/transcript/lines.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { TranscriptView } from "../../shared/messages/transcript.ts";
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
import { downloadText, safeFileName } from "./files.ts";
import { CreatorChapters, OfficialSummary } from "./guides.tsx";
import type { Panel } from "./panel.ts";
import { activeIndex, explainable, linesOf, mainBreaks, refreshLang, srtOf } from "./reading.ts";
import { setupReason } from "../shared/config.ts";
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
  const modeItems: MenuItem[] = (["original", "translated", "bilingual"] as const).map((item) => ({
    label: modeLabel[item],
    ...(item === mode ? { hint: p.inUse } : item !== "original" ? { hint: t.translateHint } : {}),
    onSelect: () => translation.setMode(item, position?.atSec),
  }));
  const exportSrt = (): void => {
    const text = srtOf(view.transcript.segments, view.transcript.cues, view.info.durationSec, mode, translation.lines.peek(), tidiedOf(panel));
    downloadText(`${safeFileName(view.info.title, t.file)}.srt`, text, "application/x-subrip");
  };
  const copyAll = (): void => {
    const text = view.transcript.segments.map((segment) => `[${formatTimestamp(segment.start)}] ${linesOf(segment, mode, translation.lines.peek(), tidiedOf(panel)).main}`).join("\n");
    void navigator.clipboard.writeText(text).then(
      () => panel.say(t.copied),
      () => panel.say(t.copyFailed),
    );
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

/** 正在显示的整理结果：用户切回原始字幕时不给。 */
const tidiedOf = (panel: Panel): Readonly<Record<string, string>> => (panel.tidy.show.peek() ? panel.tidy.lines.peek() : NO_LINES);

/**
 * 整理字幕那一行：没整理过时是按钮，写明要花额度；整理中显示进度和停止；整理过以后能在整理后和原始字幕之间切换，
 * 没整理完的可以接着整理。只在用户点的时候做，不自动做。
 */
function TidyRow({ panel, segments }: { readonly panel: Panel; readonly segments: number }) {
  const { phase, done, total, message, said } = panel.tidy.state.value;
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
  const ready = panel.config.state.value.state === "checked" && panel.config.state.value.view.ready;
  const reason = ready ? undefined : setupReason(panel.config.state.value, uiLang.value);
  return (
    <div class="tidy-row">
      {count === 0 ? (
        <Button onClick={start} disabled={!ready} {...(reason ? { disabledReason: reason } : {})} note={t.tidyNote}>
          {t.tidy}
        </Button>
      ) : (
        <>
          <Button variant="text" onClick={() => panel.tidy.setShow(!show)}>
            {show ? t.showOriginal : t.showTidied}
          </Button>
          {count < segments ? (
            <Button variant="text" onClick={start} disabled={!ready} {...(reason ? { disabledReason: reason } : {})}>
              {t.continueTidy}
            </Button>
          ) : null}
        </>
      )}
      {message ? <p class="note-line">{message}</p> : null}
      {message ? <ServiceSaid said={said} /> : null}
    </div>
  );
}

function TranslateRow({ panel }: { readonly panel: Panel }) {
  const { phase, done, total, message, said } = panel.translation.state.value;
  if (panel.translation.mode.value === "original" && phase !== "running") return null;
  if (phase === "running") {
    const p = panelText();
    return (
      <div class="progress-row" role="status">
        <span>{total > 0 ? p.transcript.translating(done, total) : p.transcript.translatingPlain}</span>
        <Button variant="text" onClick={() => panel.translation.stopRunning()}>
          {p.stop}
        </Button>
      </div>
    );
  }
  return message ? (
    <>
      <p class="progress-row">{message}</p>
      <ServiceSaid said={said} />
    </>
  ) : null;
}

function Ready({ panel, view, follow }: { readonly panel: Panel; readonly view: TranscriptView; readonly follow: boolean }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [following, setFollowing] = useState(follow);
  const [pick, setPick] = useState<{ readonly text: string; readonly context: string; readonly top: number } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const segments = view.transcript.segments;
  // 每段按原始字幕的哪几处断开：只看这一份字幕，换版本时整个列表重建。
  const breaks = useMemo(() => lineBreaks(segments, view.transcript.cues), [segments, view.transcript.cues]);
  const mode = panel.translation.mode.value;
  const translated = panel.translation.lines.value;
  const tidied = panel.tidy.show.value ? panel.tidy.lines.value : NO_LINES;
  const position = panel.player.position.value;
  const at = position?.video === view.video ? position.atSec : null;
  const active = activeIndex(segments, at);
  const needle = query.trim();
  const p = panelText();
  const t = p.transcript;
  const jumpTo = sharedText().jumpTo;
  const shown = needle ? segments.filter((segment) => { const { main, sub } = linesOf(segment, mode, translated, tidied); return hasMatch(splitMatches(`${main}\n${sub}`, needle)); }) : segments;

  useEffect(() => {
    if (!following || needle || active < 0) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "center" });
  }, [active, following, needle]);

  const onSelectEnd = (): void => {
    const selection = getSelection();
    const text = selection?.toString() ?? "";
    const anchor = selection?.anchorNode?.parentElement?.closest<HTMLElement>(".cue");
    if (!selection || !anchor || !explainable(text)) {
      setPick(null);
      return;
    }
    const box = selection.getRangeAt(0).getBoundingClientRect();
    const host = list.current?.getBoundingClientRect();
    setPick({ text: text.trim(), context: anchor.querySelector(".cue-text")?.textContent ?? "", top: box.bottom - (host?.top ?? 0) + (list.current?.scrollTop ?? 0) });
  };

  return (
    <>
      <Toolbar panel={panel} view={view} searching={searching} onSearch={() => { setSearching(!searching); setQuery(""); }} onImport={() => fileInput.current?.click()} />
      <ImportInput panel={panel} inputRef={fileInput} />
      {searching ? (
        <div class="search-row">
          <input class="search-input" type="search" placeholder={t.searchPlaceholder} aria-label={t.search} value={query} autoFocus onInput={(event) => setQuery(event.currentTarget.value)} />
          <span class="search-count">{needle ? t.matches(shown.length) : ""}</span>
        </div>
      ) : null}
      <TranslateRow panel={panel} />
      <TidyRow panel={panel} segments={segments.length} />
      <ol class="cues" ref={list} onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onMouseUp={onSelectEnd} onKeyUp={onSelectEnd}>
        {shown.map((segment) => {
          const index = segments.indexOf(segment);
          const { main, sub } = linesOf(segment, mode, translated, tidied);
          return (
            <li key={segment.id} class="cue" data-index={index} data-active={index === active ? "true" : undefined}>
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
            </li>
          );
        })}
        {pick ? (
          <li class="explain-pick" style={{ top: `${pick.top}px` }}>
            <Button variant="primary" onClick={() => { setPick(null); void panel.qa.explainSelection(pick.text, pick.context); }}>
              {t.explain}
            </Button>
          </li>
        ) : null}
      </ol>
      {needle && shown.length === 0 ? <p class="empty-line">{p.notFound(needle)}</p> : null}
      {!following && at !== null ? (
        <button type="button" class="follow-pill" onClick={() => setFollowing(true)}>
          <Icon name="target" />
          <span>{t.backToCurrent}</span>
        </button>
      ) : null}
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
  return <Ready key={now.view.transcript.ref.fingerprint} panel={panel} view={now.view} follow={follow} />;
}
