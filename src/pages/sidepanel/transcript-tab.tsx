// 字幕列表：精读的主体，速览里还没有概览时也摆在下面。逐段字幕，点一段跳到那里，跟着播放位置滚动；搜索高亮、换原文译文双语、导入导出字幕文件。
// 读不到字幕时说明原因，视频网站给的导读照样摆出来；选中一段文字可以请模型解释。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { lineBreaks, splitRuns } from "../../core/transcript/lines.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { TranscriptView } from "../../shared/messages/transcript.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { Icon } from "../shared/ui/icon.tsx";
import { Menu, type MenuItem } from "../shared/ui/menu.tsx";
import { Sheet } from "../shared/ui/overlay.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { stateCopy } from "../shared/ui/state.ts";
import { downloadText, safeFileName } from "./files.ts";
import { CreatorChapters, OfficialSummary } from "./guides.tsx";
import type { Panel } from "./panel.ts";
import { activeIndex, explainable, linesOf, mainBreaks, srtOf } from "./reading.ts";
import type { TranscriptMode } from "./translate.ts";

const MODE_LABEL: Readonly<Record<TranscriptMode, string>> = { original: "原文", translated: "译文", bilingual: "双语" };

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
  return (
    <Sheet open={open} title={explain.selection ? `解释：${explain.selection}` : "解释"} onClose={() => panel.qa.closeExplain()}>
      <p class="explain-body" data-phase={explain.phase} aria-live="polite">
        {explain.phase === "running" ? "正在请模型解释…" : explain.text}
      </p>
    </Sheet>
  );
}

function Toolbar({ panel, view, onSearch, searching, onImport }: { readonly panel: Panel; readonly view: TranscriptView; readonly onSearch: () => void; readonly searching: boolean; readonly onImport: () => void }) {
  const { translation, transcript, follow } = panel;
  const mode = translation.mode.value;
  const position = panel.player.position.value;
  const modeItems: MenuItem[] = (["original", "translated", "bilingual"] as const).map((item) => ({
    label: MODE_LABEL[item],
    ...(item === mode ? { hint: "正在用" } : item !== "original" ? { hint: "会请模型翻译没译过的段落" } : {}),
    onSelect: () => translation.setMode(item, position?.atSec),
  }));
  const exportSrt = (): void => {
    const text = srtOf(view.transcript.segments, view.transcript.cues, view.info.durationSec, mode, translation.lines.peek(), tidiedOf(panel));
    downloadText(`${safeFileName(view.info.title, "字幕")}.srt`, text, "application/x-subrip");
  };
  const copyAll = (): void => {
    const text = view.transcript.segments.map((segment) => `[${formatTimestamp(segment.start)}] ${linesOf(segment, mode, translation.lines.peek(), tidiedOf(panel)).main}`).join("\n");
    void navigator.clipboard.writeText(text).then(
      () => panel.say("已复制全部字幕"),
      () => panel.say("没能复制，浏览器拒绝了剪贴板"),
    );
  };
  const moreItems: MenuItem[] = [
    {
      label: "重新读取字幕",
      hint: "不看本机缓存",
      // 导入的字幕不点名语言：点名语言会改读平台的字幕轨，绕过导入的文件。
      onSelect: () => void transcript.load(view.video, follow.target.peek().tabId, { ...(view.transcript.fileName ? {} : { lang: view.transcript.ref.lang }), fresh: true }),
    },
    { label: "复制全部字幕", onSelect: copyAll },
    { label: "导出 SRT", hint: `内容跟着${MODE_LABEL[mode]}视图`, onSelect: exportSrt },
    { label: "导入字幕文件", hint: "SRT 或 VTT，只存在这台电脑上", onSelect: onImport },
    ...(view.transcript.fileName ? [{ label: "移除导入的字幕", hint: "换回视频网站的字幕", onSelect: () => void transcript.removeImport().then(panel.say) }] : []),
  ];
  return (
    <div class="toolbar">
      <span class="toolbar-count">共 {view.transcript.segments.length} 段</span>
      <span class="toolbar-actions">
        <Menu label="字幕视图" icon="chevron" text={MODE_LABEL[mode]} items={modeItems} />
        <IconButton icon="search" label="搜索字幕" pressed={searching} onClick={onSearch} />
        <Menu label="更多字幕操作" items={moreItems} />
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
  const { phase, done, total, message } = panel.tidy.state.value;
  const count = Object.keys(panel.tidy.lines.value).length;
  const show = panel.tidy.show.value;
  const start = (): void => {
    const position = panel.player.position.peek();
    panel.tidy.start(position?.atSec);
  };
  if (phase === "running") {
    return (
      <div class="progress-row" role="status">
        <span>{total > 0 ? `正在整理字幕 ${done}/${total} 段` : "正在整理字幕…"}</span>
        <Button variant="text" onClick={() => panel.tidy.stopRunning()}>
          停止
        </Button>
      </div>
    );
  }
  const ready = panel.config.state.value.state === "checked" && panel.config.state.value.view.ready;
  const reason = ready ? undefined : "先在设置页设置 AI 服务";
  return (
    <div class="tidy-row">
      {count === 0 ? (
        <Button onClick={start} disabled={!ready} {...(reason ? { disabledReason: reason } : {})} note="补标点、改同音错字，要用 API 额度；长视频大约和翻译一遍差不多">
          整理字幕
        </Button>
      ) : (
        <>
          <Button variant="text" onClick={() => panel.tidy.setShow(!show)}>
            {show ? "看原始字幕" : "看整理后的字幕"}
          </Button>
          {count < segments ? (
            <Button variant="text" onClick={start} disabled={!ready} {...(reason ? { disabledReason: reason } : {})}>
              接着整理
            </Button>
          ) : null}
        </>
      )}
      {message ? <p class="note-line">{message}</p> : null}
    </div>
  );
}

function TranslateRow({ panel }: { readonly panel: Panel }) {
  const { phase, done, total, message } = panel.translation.state.value;
  if (panel.translation.mode.value === "original" && phase !== "running") return null;
  if (phase === "running") {
    return (
      <div class="progress-row" role="status">
        <span>{total > 0 ? `正在翻译 ${done}/${total} 段` : "正在翻译…"}</span>
        <Button variant="text" onClick={() => panel.translation.stopRunning()}>
          停止
        </Button>
      </div>
    );
  }
  return message ? <p class="progress-row">{message}</p> : null;
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
          <input class="search-input" type="search" placeholder="搜索字幕（原文和译文都会搜）" aria-label="搜索字幕" value={query} autoFocus onInput={(event) => setQuery(event.currentTarget.value)} />
          <span class="search-count">{needle ? `${shown.length} 处` : ""}</span>
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
              <button type="button" class="cue-time" aria-label={`跳到 ${formatTimestamp(segment.start)}`} onClick={() => void panel.seek(segment.start)}>
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
              解释
            </Button>
          </li>
        ) : null}
      </ol>
      {needle && shown.length === 0 ? <p class="empty-line">没有找到「{needle}」</p> : null}
      {!following && at !== null ? (
        <button type="button" class="follow-pill" onClick={() => setFollowing(true)}>
          <Icon name="target" />
          <span>回到当前句</span>
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
  if (now.state === "idle" || now.state === "loading") {
    return (
      <div class="loading" role="status">
        <p class="loading-title">正在读取字幕…</p>
        <span class="ske-line" />
        <span class="ske-line" />
        <span class="ske-line" />
      </div>
    );
  }
  if (now.state === "failed") {
    const { failure, video } = now;
    const copy = stateCopy(failure.code, failure.detail);
    const guided = guides && failure.official?.status === "ok";
    return (
      <>
        <StateBlock
          {...copy}
          {...(guided ? { impact: `${copy.impact ?? ""}下面是视频网站给的导读。` } : {})}
          primary={{ label: "重试", onClick: () => void panel.transcript.load(video, panel.follow.target.peek().tabId, { fresh: true }) }}
          secondary={[{ label: "导入字幕文件", onClick: () => fileInput.current?.click() }]}
        />
        <ImportInput panel={panel} inputRef={fileInput} />
        {guides ? <OfficialSummary official={failure.official} onSeek={(at) => void panel.seek(at)} /> : null}
        {guides ? <CreatorChapters chapters={failure.chapters} onSeek={(at) => void panel.seek(at)} /> : null}
      </>
    );
  }
  return <Ready key={now.view.transcript.ref.fingerprint} panel={panel} view={now.view} follow={follow} />;
}
