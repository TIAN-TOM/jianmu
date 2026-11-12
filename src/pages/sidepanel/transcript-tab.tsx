// 字幕页签：逐段字幕，点一段跳到那里，跟着播放位置滚动；搜索高亮、换原文译文双语、导入导出字幕文件。
// 读不到字幕时说明原因，视频网站给的导读照样摆出来；选中一段文字可以请模型解释。
import { useEffect, useRef, useState } from "preact/hooks";
import { describe } from "../../core/errors.ts";
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { TranscriptView } from "../../shared/messages/transcript.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { Icon } from "../shared/ui/icon.tsx";
import { Menu, type MenuItem } from "../shared/ui/menu.tsx";
import { Sheet } from "../shared/ui/overlay.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { downloadText, safeFileName } from "./files.ts";
import { CreatorChapters, OfficialSummary } from "./guides.tsx";
import type { Panel } from "./panel.ts";
import { activeIndex, explainable, linesOf, srtOf } from "./reading.ts";
import type { TranscriptMode } from "./translate.ts";

const MODE_LABEL: Readonly<Record<TranscriptMode, string>> = { original: "原文", translated: "译文", bilingual: "双语" };

function Highlighted({ text, query }: { readonly text: string; readonly query: string }) {
  const parts = splitMatches(text, query);
  if (!hasMatch(parts)) return <>{text}</>;
  return <>{parts.map((part, index) => (part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}</>;
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
    const text = srtOf(view.transcript.segments, view.transcript.cues, view.info.durationSec, mode, translation.lines.peek());
    downloadText(`${safeFileName(view.info.title, "字幕")}.srt`, text, "application/x-subrip");
  };
  const copyAll = (): void => {
    const text = view.transcript.segments.map((segment) => `[${formatTimestamp(segment.start)}] ${linesOf(segment, mode, translation.lines.peek()).main}`).join("\n");
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

function Ready({ panel, view }: { readonly panel: Panel; readonly view: TranscriptView }) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [following, setFollowing] = useState(true);
  const [pick, setPick] = useState<{ readonly text: string; readonly context: string; readonly top: number } | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const segments = view.transcript.segments;
  const mode = panel.translation.mode.value;
  const translated = panel.translation.lines.value;
  const position = panel.player.position.value;
  const at = position?.video === view.video ? position.atSec : null;
  const active = activeIndex(segments, at);
  const needle = query.trim();
  const shown = needle ? segments.filter((segment) => { const { main, sub } = linesOf(segment, mode, translated); return hasMatch(splitMatches(`${main}\n${sub}`, needle)); }) : segments;

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
      <ol class="cues" ref={list} onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} onMouseUp={onSelectEnd} onKeyUp={onSelectEnd}>
        {shown.map((segment) => {
          const index = segments.indexOf(segment);
          const { main, sub } = linesOf(segment, mode, translated);
          return (
            <li key={segment.id} class="cue" data-index={index} data-active={index === active ? "true" : undefined}>
              <button type="button" class="cue-time" aria-label={`跳到 ${formatTimestamp(segment.start)}`} onClick={() => void panel.seek(segment.start)}>
                {formatTimestamp(segment.start)}
              </button>
              <p class="cue-text">
                <Highlighted text={main} query={needle} />
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

export function TranscriptTab({ panel }: { readonly panel: Panel }) {
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
    return (
      <>
        <StateBlock
          title={describe(failure.code, failure.detail)}
          {...(failure.official?.status === "ok" ? { impact: "下面是视频网站给的导读。" } : {})}
          primary={{ label: "重试", onClick: () => void panel.transcript.load(video, panel.follow.target.peek().tabId, { fresh: true }) }}
          secondary={[{ label: "导入字幕文件", onClick: () => fileInput.current?.click() }]}
        />
        <ImportInput panel={panel} inputRef={fileInput} />
        <OfficialSummary official={failure.official} onSeek={(at) => void panel.seek(at)} />
        <CreatorChapters chapters={failure.chapters} onSeek={(at) => void panel.seek(at)} />
      </>
    );
  }
  return <Ready key={now.view.transcript.ref.fingerprint} panel={panel} view={now.view} />;
}
