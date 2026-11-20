// 卡片的界面：标题栏（展开收起）、提示、AI 概览（结论在最前，章节默认只露前几章）、B 站官方总结（有概览时收成一行）、进度和按钮。
// 收起时标题栏那一行写着判断档和播放到的章节（或者临时的一句话），旁边是打开侧边栏的入口；侧边栏开着时不摆这个入口。
// 按钮行在内容还在来时先不摆（规则在 model.ts），摆出来以后不被晚到的内容顶走。
// 规则在 model.ts。视频标题不在卡片里再写一遍：页面顶上就是。
// 展开收起有过渡：标题栏下面那一整块的高度从零长到内容那么高，卡片把每一帧的高度报给页面，外面的框架跟着走。
import type { ComponentChildren, RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { OfficialSummaryView, OutlineSectionView } from "../../shared/messages/transcript.ts";
import { keyChapterStarts, verdictName } from "../../core/ai/verdict.ts";
import { ChapterList, type ChapterItem } from "../shared/ui/chapter-list.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StaleTranscriptLine, VerdictBlock } from "../shared/ui/verdict-block.tsx";
import { staleOverviewMarks, type BasisSource } from "../shared/ui/verdict.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { cardRows, chaptersInOrder, hasOverview, type CardView, type TaskProgress } from "./model.ts";
import { cardText } from "./text.ts";

type ClickEvent = { readonly isTrusted: boolean };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const validTime = (atSec: number | null): atSec is number => atSec !== null && Number.isFinite(atSec) && atSec >= 0;

/** 时间这一列按最长的那个时间定宽，后面的标题才对得齐。 */
const timeColumn = (times: readonly (number | null)[]): string => `--time-ch:${Math.max(4, ...times.map((at) => (validTime(at) ? formatTimestamp(at).length : 0)))}`;

function TimeCell({ atSec, onSeek }: { readonly atSec: number | null; readonly onSeek: (atSec: number) => void }) {
  return (
    <span class="outline-time">
      {validTime(atSec) ? (
        <button type="button" class="chapter-time" aria-label={cardText().jumpTo(formatTimestamp(atSec))} onClick={() => onSeek(atSec)}>
          {formatTimestamp(atSec)}
        </button>
      ) : null}
    </span>
  );
}

function OutlineItem({ part, index, onSeek }: { readonly part: OutlineSectionView; readonly index: number; readonly onSeek: (atSec: number) => void }) {
  const title = part.title.trim() || cardText().section(index + 1);
  const points = part.points.filter((point) => point.content.trim());
  return (
    <li class="outline-item">
      <TimeCell atSec={part.timestamp} onSeek={onSeek} />
      {points.length ? (
        <details class="outline-details">
          <summary class="outline-title">{title}</summary>
          <ul class="points">
            {points.map((point, at) => (
              <li key={at} class="point">
                <TimeCell atSec={point.timestamp} onSeek={onSeek} />
                <span>{point.content.trim()}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <span class="outline-title">{title}</span>
      )}
    </li>
  );
}

function More({ open, label, onToggle }: { readonly open: boolean; readonly label: string; readonly onToggle: () => void }) {
  return (
    <button type="button" class="card-more" aria-expanded={open} onClick={onToggle}>
      {open ? cardText().less : label}
    </button>
  );
}

/**
 * 只露三行的正文底下是不是真的藏着字。量出来的，不按字数猜：同样的字数，字号大、卡片窄时三行就放不下。
 * 字号或宽度变了重新量。watch 变了（换了正文、展开收起）也重新量。
 */
function useClipped(watch: string): [RefObject<HTMLParagraphElement>, boolean] {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return setClipped(false);
    const measure = (): void => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [watch]);
  return [ref, clipped];
}

/**
 * 官方总结的正文和提纲。limited 时正文只露三行、提纲只露前几段；给了 onToggleAll，有藏起来的（或者已经展开）时下面摆「展开全部」。
 */
function OfficialBody({ official, limited, onSeek, onToggleAll }: { readonly official: OfficialSummaryView; readonly limited: boolean; readonly onSeek: (atSec: number) => void; readonly onToggleAll?: () => void }) {
  const summary = official.summary.trim();
  const outline = cardRows(official.outline, !limited);
  const outlineCut = cardRows(official.outline, false).length < official.outline.length;
  const [reading, clipped] = useClipped(`${limited}:${summary}`);
  return (
    <>
      {summary ? (
        <p class="card-reading" ref={reading} data-clamp={limited ? "true" : undefined}>
          {summary}
        </p>
      ) : null}
      {outline.length ? (
        <ol class="outline" style={timeColumn(outline.flatMap((part) => [part.timestamp, ...part.points.map((point) => point.timestamp)]))}>
          {outline.map((part, index) => (
            <OutlineItem key={index} part={part} index={index} onSeek={onSeek} />
          ))}
        </ol>
      ) : null}
      {onToggleAll && (!limited || outlineCut || clipped) ? <More open={!limited} label={outlineCut ? cardText().showAllSections(official.outline.length) : cardText().showAll} onToggle={onToggleAll} /> : null}
    </>
  );
}

function basisOf(analysis: LearningAnalysis): BasisSource | null {
  const source = text(analysis.verdict?.source);
  if (source === "official" || source === "official-summary") return "official-summary";
  return hasOverview(analysis) ? "transcript" : null;
}

function Overview({
  analysis,
  stale,
  pending,
  showAll,
  onSeek,
  onToggleAll,
}: {
  readonly analysis: LearningAnalysis;
  /** 换过字幕：结论块里标结论的，章节的单独一行。 */
  readonly stale: { readonly verdict: boolean; readonly chapters: boolean };
  readonly pending: boolean | string;
  readonly showAll: boolean;
  readonly onSeek: (atSec: number) => void;
  readonly onToggleAll: () => void;
}) {
  const verdict = analysis.verdict;
  const summary = text(verdict?.summary);
  const chapters: ChapterItem[] = (analysis.chapters ?? []).map((chapter) => ({ startSec: chapter.timestampSeconds, title: text(chapter.title) }));
  const shown = cardRows(chapters, showAll);
  const cut = cardRows(chapters, false).length < chapters.length;
  const t = cardText();
  return (
    <section class="card-block" id="card-overview" aria-label={t.overview}>
      {pending ? (
        <p class="card-pending" role="status">
          {typeof pending === "string" ? pending : t.writingVerdict}
        </p>
      ) : summary ? (
        <VerdictBlock label={text(verdict?.verdict)} text={summary} basis={basisOf(analysis)} staleTranscript={stale.verdict} incomplete={verdict?.incomplete === true} />
      ) : null}
      {stale.chapters && shown.length ? <StaleTranscriptLine /> : null}
      {shown.length ? <ChapterList chapters={shown} keyStarts={keyChapterStarts(analysis)} heading={false} onSeek={onSeek} /> : null}
      {cut ? <More open={showAll} label={t.showAllChapters(chapters.length)} onToggle={onToggleAll} /> : null}
    </section>
  );
}

function progressText(task: TaskProgress): string {
  const t = cardText();
  if (task.canceling) return t.stopping;
  const text = task.message || (task.total > 0 ? t.chunksDone(task.done, task.total) : "");
  if (task.auto) return text ? t.auto(text) : t.autoStarting;
  return text || t.preparing;
}

/** 收起的那一行：有结论时写判断档；后面是临时的一句话，没有的话写播放到的章节，和侧边栏精读顶上那一条同一个写法。 */
export function glanceOf(view: CardView): { readonly label: string; readonly text: string } {
  if (!view.collapsed) return { label: "", text: "" };
  const verdict = view.verdictPending ? undefined : view.analysis?.verdict;
  const label = text(verdict?.summary) ? text(verdict?.verdict) : "";
  if (view.headNote) return { label, text: view.headNote };
  const chapters = chaptersInOrder(view.analysis);
  const now = view.chapterNow === null ? undefined : chapters[view.chapterNow];
  return { label, text: now && view.chapterNow !== null ? `${view.chapterNow + 1}/${chapters.length} ${now.title || formatTimestamp(now.startSec)}` : "" };
}

export interface CardActions {
  readonly toggle: () => void;
  readonly generate: (event: ClickEvent) => void;
  readonly cancel: () => void;
  readonly retry: () => void;
  readonly openPanel: (event: ClickEvent) => void;
  readonly openSettings: (event: ClickEvent) => void;
  readonly seek: (atSec: number) => void;
  readonly toggleShowAll: () => void;
  readonly toggleOfficial: () => void;
}

/** 点了展开而内容还在读：最多等这么久再打开，读到了就直接从标题栏长到内容那么高，不先露一行「正在读取」。 */
export const OPEN_HOLD_MS = 500;

/**
 * 标题栏下面那一整块，展开收起时高度有过渡。收起时内容留到过渡走完才拿掉，这期间点不到、读屏也读不到；
 * 没有过渡（系统设了减少动效）就马上拿掉。已经开着时换内容不关，高度照旧直接变。
 */
function Fold({ collapsed, waiting, children }: { readonly collapsed: boolean; readonly waiting: boolean; readonly children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(!collapsed && !waiting);
  const [gone, setGone] = useState(!open);
  useLayoutEffect(() => {
    if (collapsed) return setOpen(false);
    if (!waiting) return setOpen(true);
    const timer = setTimeout(() => setOpen(true), OPEN_HOLD_MS);
    return () => clearTimeout(timer);
  }, [collapsed, waiting]);
  useLayoutEffect(() => {
    if (open) return setGone(false);
    const node = ref.current;
    if (!node || !(parseFloat(getComputedStyle(node).transitionDuration) > 0)) setGone(true);
  }, [open]);
  return (
    <div
      ref={ref}
      class="card-sheet"
      data-open={open ? "true" : "false"}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setGone(true);
      }}
    >
      <div class="card-sheet-in" inert={!open}>
        {open || !gone ? children : null}
      </div>
    </div>
  );
}

/** setupHint 是 AI 服务没设置好时生成概览按钮旁的说明，按缺什么说。 */
export function Card({ view, aiReady, setupHint, actions }: { readonly view: CardView; readonly aiReady: boolean | null; readonly setupHint: string; readonly actions: CardActions }) {
  if (!view.visible) return null;
  const canGenerate = view.phase === "loaded" && !view.noCaptions && !view.needLogin && !view.notRead && !hasOverview(view.analysis) && !view.task;
  // 本机还没有字幕：在侧边栏读过以后点重试，不用刷新页面就能生成。已经有概览时用不着。
  const retryRead = view.notRead && !hasOverview(view.analysis);
  const needsSetup = canGenerate && aiReady === false;
  const analysis = view.analysis && (view.analysis.verdict || hasOverview(view.analysis) || view.verdictPending) ? view.analysis : null;
  const official = view.official?.status === "ok" ? view.official : null;
  const t = cardText();
  const officialNotes: Readonly<Partial<Record<OfficialSummaryView["status"], string>>> = t.officialNotes;
  // 没登录时上面已经说了要登录，官方总结那块不再重复。
  const officialNote = view.official && view.phase === "loaded" && !(view.needLogin && view.official.status === "need-login") ? (officialNotes[view.official.status] ?? "") : "";
  const task = view.task;
  const percent = task && task.total > 0 ? Math.round((task.done / task.total) * 100) : 0;
  const glance = glanceOf(view);
  const showGenerate = canGenerate && !needsSetup;
  const showSettings = needsSetup || (canGenerate && view.settingsError);
  const showRetry = (view.phase === "failed" || view.needLogin || retryRead) && !task;
  // 侧边栏已经开着：不摆打开它的按钮。别的按钮也都没有时，这一行整个不摆。
  const showActions = !view.holdActions && (showGenerate || showSettings || showRetry || !view.panelOpen);
  return (
    <div class="card" id="card" data-collapsed={view.collapsed ? "true" : "false"}>
      <div class="card-head-row">
        <button type="button" class="card-head" id="card-toggle" aria-expanded={!view.collapsed} aria-controls="card-body" title={view.collapsed ? t.expand : t.collapse} onClick={actions.toggle}>
          <span class="card-dot" aria-hidden="true" />
          <span class="card-name">{t.name(verdictName(glance.label, uiLang.value))}</span>
          {glance.text ? (
            <span class="card-glance" id="card-glance" role={view.headNote ? "status" : undefined}>
              {glance.text}
            </span>
          ) : null}
          <span class="card-chevron" aria-hidden="true" />
        </button>
        {view.collapsed && !view.panelOpen ? (
          <button type="button" class="card-head-panel" id="card-head-panel" title={t.openPanel} onClick={actions.openPanel}>
            {t.headPanel}
          </button>
        ) : null}
      </div>
      <Fold collapsed={view.collapsed} waiting={view.phase === "loading"}>
        <div class="card-body" id="card-body">
          {view.notice ? (
            <p class="card-status" id="card-status" role="status" data-tone={view.notice.tone || undefined}>
              {view.notice.text}
            </p>
          ) : null}
          <ServiceSaid said={view.notice?.said} />
          {analysis ? (
            <Overview
              analysis={analysis}
              stale={staleOverviewMarks(view.transcriptBasis ?? undefined, view.transcriptFingerprint, !view.verdictPending && text(analysis.verdict?.summary) !== "")}
              pending={view.verdictPending}               showAll={view.showAll}
              onSeek={actions.seek}
              onToggleAll={actions.toggleShowAll}
            />
          ) : null}
          {official && analysis ? (
            // 已经有结论和章节：官方总结收成一行，点开才露。
            <section class="card-block" id="card-official" aria-label={t.official}>
              <button type="button" class="card-fold-head" aria-expanded={view.officialOpen} aria-controls={view.officialOpen ? "card-official-body" : undefined} onClick={actions.toggleOfficial}>
                <span>{t.official}</span>
                <span class="card-chevron" aria-hidden="true" />
              </button>
              {view.officialOpen ? (
                <div class="card-fold-body" id="card-official-body">
                  <OfficialBody official={official} limited={false} onSeek={actions.seek} />
                </div>
              ) : null}
            </section>
          ) : official ? (
            <section class="card-block" id="card-official" aria-label={t.official}>
              <h2 class="section-title">{t.official}</h2>
              <OfficialBody official={official} limited={!view.showAll} onSeek={actions.seek} onToggleAll={actions.toggleShowAll} />
            </section>
          ) : officialNote ? (
            <p class="card-note">{officialNote}</p>
          ) : null}
          {needsSetup ? <p class="card-note" id="card-setup">{setupHint}</p> : null}
        </div>
        {task ? (
          <div class="card-progress" id="card-progress" role="status">
            <div class="card-track">
              <div class="card-bar" style={{ width: `${percent}%` }} />
            </div>
            <span class="card-progress-text">{progressText(task)}</span>
            <button type="button" class="button" data-variant="text" disabled={task.canceling} onClick={actions.cancel}>
              {t.stop}
            </button>
          </div>
        ) : null}
        {showActions ? (
          <div class="card-actions">
            {showGenerate ? (
              <button type="button" class="button" data-variant="primary" id="card-generate" onClick={actions.generate}>
                {t.generate}
              </button>
            ) : null}
            {showSettings ? (
              <button type="button" class="button" data-variant={needsSetup ? "primary" : "secondary"} id="card-settings" onClick={actions.openSettings}>
                {t.openSettings}
              </button>
            ) : null}
            {showRetry ? (
              <button type="button" class="button" id="card-retry" onClick={actions.retry}>
                {t.retry}
              </button>
            ) : null}
            {view.panelOpen ? null : (
              <button type="button" class="button" id="card-panel" onClick={actions.openPanel}>
                {t.openPanel}
              </button>
            )}
          </div>
        ) : null}
      </Fold>
    </div>
  );
}
