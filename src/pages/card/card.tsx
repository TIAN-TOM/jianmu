// 播放页卡片。头部的更多操作和生成进度在滚动正文上方，展开收起沿用框架的高度上报。
import type { ComponentChildren, RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LearningAnalysis } from "../../core/notes/records.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { OfficialSummaryView, OutlineSectionView } from "../../shared/messages/transcript.ts";
import { keyChapterStarts, type VerdictRating } from "../../core/ai/verdict.ts";
import type { ChapterItem } from "../shared/ui/chapter-list.tsx";
import { Collapse } from "../shared/ui/collapse.tsx";
import { CommentFold, commentViewOfVerdict } from "../shared/ui/comment-block.tsx";
import { Icon } from "../shared/ui/icon.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StaleTranscriptLine, VerdictBlock, VerdictLabel } from "../shared/ui/verdict-block.tsx";
import { bandOf, staleOverviewMarks, type BasisSource } from "../shared/ui/verdict.ts";
import { CardChapters } from "./chapters.tsx";
import { cardRows, chaptersInOrder, hasOverview, type CardView, type TaskProgress } from "./model.ts";
import { canWriteFromOfficial } from "./official-verdict.ts";
import { ASK_IDLE, type AskState } from "./ask.ts";
import { CardAskBox } from "./ask-view.tsx";
import { conclusionOf } from "./glance.ts";
import { cardText } from "./text.ts";

// 评论区那一行（PRD F23），有要点时点开才露：关掉开关的构建里连同组件和文案一起裁掉。
const CardComments = FEATURE_COMMENTS ? CommentFold : null;
const commentsOf = FEATURE_COMMENTS ? commentViewOfVerdict : null;

type ClickEvent = { readonly isTrusted: boolean };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const validTime = (atSec: number | null): atSec is number => atSec !== null && Number.isFinite(atSec) && atSec >= 0;

/** 时间这一列按最长的那个时间定宽，后面的标题才对得齐。 */
const timeColumn = (times: readonly (number | null)[]): string => `--time-ch:${Math.max(4, ...times.map((at) => (validTime(at) ? formatTimestamp(at).length : 0)))}`;

function TimeCell({ atSec, onSeek }: { readonly atSec: number | null; readonly onSeek: (atSec: number) => void }) {
  return (
    <>
      <span class="key-play" aria-hidden="true" />
      {validTime(atSec) ? (
        <button type="button" class="chapter-time" aria-label={cardText().jumpTo(formatTimestamp(atSec))} onClick={() => onSeek(atSec)}>
          {formatTimestamp(atSec)}
        </button>
      ) : (
        <span class="chapter-time" aria-hidden="true">{"\u00a0"}</span>
      )}
    </>
  );
}

function OutlineItem({ part, index, onSeek }: { readonly part: OutlineSectionView; readonly index: number; readonly onSeek: (atSec: number) => void }) {
  const title = part.title.trim() || cardText().section(index + 1);
  const points = part.points.filter((point) => point.content.trim());
  return (
    <li class="outline-item chapter-row">
      <TimeCell atSec={part.timestamp} onSeek={onSeek} />
      {points.length ? (
        <details class="outline-details">
          <summary class="outline-title">{title}</summary>
          <ul class="points chapter-list">
            {points.map((point, at) => (
              <li key={at} class="point chapter-row">
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

function More({ open, label, onToggle, id }: { readonly open: boolean; readonly label: string; readonly onToggle: () => void; readonly id?: string }) {
  return (
    <button type="button" class="card-more" id={id} aria-expanded={open} onClick={onToggle}>
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
function OfficialBody({ official, chapters, limited, onSeek, onToggleAll }: { readonly official: OfficialSummaryView; readonly chapters?: LearningAnalysis["chapters"]; readonly limited: boolean; readonly onSeek: (atSec: number) => void; readonly onToggleAll?: () => void }) {
  const summary = official.summary.trim();
  const outline = cardRows(official.outline, !limited);
  const times = chapters?.length
    ? chapters.map((chapter) => chapter.timestampSeconds)
    : official.outline.flatMap((part) => [part.timestamp, ...part.points.map((point) => point.timestamp)]);
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
        <ol class="outline chapter-list" style={timeColumn(times)}>
          {outline.map((part, index) => (
            <OutlineItem key={index} part={part} index={index} onSeek={onSeek} />
          ))}
        </ol>
      ) : null}
      {onToggleAll && (!limited || outlineCut || clipped) ? <More open={!limited} label={outlineCut ? cardText().showAllSections(official.outline.length) : cardText().showAll} onToggle={onToggleAll} /> : null}
    </>
  );
}

// 卡片地方小，依据字幕是常态不标；只有没读字幕、靠官方总结写的结论才提醒一句。
function basisOf(analysis: LearningAnalysis): BasisSource | null {
  const source = text(analysis.verdict?.source);
  return source === "official" || source === "official-summary" ? "official-summary" : null;
}

function Overview({
  analysis,
  stale,
  pending,
  commentsOpen,
  onToggleComments,
  onSeek,
}: {
  readonly analysis: LearningAnalysis;
  /** 换过字幕：结论块里标结论的，章节的单独一行。 */
  readonly stale: { readonly verdict: boolean; readonly chapters: boolean };
  readonly pending: boolean;
  readonly commentsOpen: boolean;
  readonly onToggleComments: () => void;
  readonly onSeek: (atSec: number) => void;
}) {
  const verdict = analysis.verdict;
  const summary = text(verdict?.summary);
  const comments = commentsOf?.(verdict) ?? null;
  // 卡片上等过它（先是「正在写结论」）：写好了进来时淡一下，标记有「有结果了」那一下。
  const waited = useRef(false);
  if (pending) waited.current = true;
  // 每一章都到下一章为止：时长条按整份章节算。
  const all = analysis.chapters ?? [];
  const chapters: ChapterItem[] = all.map((chapter, index) => {
    const next = all[index + 1]?.timestampSeconds;
    return { startSec: chapter.timestampSeconds, title: text(chapter.title), ...(next === undefined ? {} : { endSec: next }) };
  });
  const t = cardText();
  return (
    <section class="card-block" id="card-overview" aria-label={t.overview}>
      {!pending && summary ? (
        <VerdictBlock label={verdict?.verdict} cardReason={text(verdict?.reason)} text={summary} basis={basisOf(analysis)} staleTranscript={stale.verdict} incomplete={verdict?.incomplete === true} fresh={waited.current} />
      ) : null}
      {CardComments && comments && summary && !pending ? <CardComments view={comments} open={commentsOpen} onToggle={onToggleComments} /> : null}
      {stale.chapters && chapters.length ? <StaleTranscriptLine /> : null}
      {chapters.length ? <CardChapters chapters={chapters} keyStarts={keyChapterStarts(analysis)} onSeek={onSeek} /> : null}
    </section>
  );
}

function progressText(task: TaskProgress, pending: CardView["verdictPending"]): string {
  const t = cardText();
  if (task.canceling) return t.stopping;
  if (task.verdict) return t.writingVerdict;
  const fallback = task.total > 0 ? t.chunksDone(task.done, task.total) : typeof pending === "string" ? pending : "";
  const text = pending === true ? t.writingVerdict : task.message || fallback;
  if (task.auto) return text ? t.auto(text) : t.autoStarting;
  return text || t.preparing;
}

/**
 * 标题栏上的判断和收起时后面那句话。临时的一句话最优先，其次是理由或摘要；没有结论时写播放到的章节。
 */
export function glanceOf(view: CardView): { readonly label: VerdictRating | ""; readonly text: string } {
  const conclusion = conclusionOf(view);
  const label = conclusion?.label ?? "";
  if (!view.collapsed) return { label, text: "" };
  if (view.headNote) return { label, text: view.headNote };
  if (conclusion) return conclusion;
  const chapters = chaptersInOrder(view.analysis);
  const now = view.chapterNow === null ? undefined : chapters[view.chapterNow];
  if (now && view.chapterNow !== null) return { label, text: `${view.chapterNow + 1}/${chapters.length} ${now.title || formatTimestamp(now.startSec)}` };
  return { label, text: "" };
}

export interface CardActions {
  readonly toggle: () => void;
  readonly toggleMore: () => void;
  readonly generate: (event: ClickEvent) => void;
  readonly fromOfficial: (event: ClickEvent) => void;
  readonly retryFailed: (event: ClickEvent) => void;
  /** 点「重新生成」或确认那一行的「取消」：摆出或收起确认。 */
  readonly askRegenerate: () => void;
  readonly regenerate: (event: ClickEvent) => void;
  readonly ask: (question: string, event: ClickEvent) => void;
  readonly cancelAsk: () => void;
  readonly cancel: () => void;
  readonly retry: () => void;
  readonly openPanel: (event: ClickEvent) => void;
  readonly openSettings: (event: ClickEvent) => void;
  readonly seek: (atSec: number) => void;
  readonly toggleShowAll: () => void;
  readonly toggleOfficial: () => void;
  readonly toggleComments: () => void;
}

/** 确认时焦点先落在取消上；模型另有防连点的延时。 */
function RegenerateConfirm({ onConfirm, onCancel }: { readonly onConfirm: (event: ClickEvent) => void; readonly onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => cancel.current?.focus(), []);
  const t = cardText();
  return (
    <div class="card-confirm" id="card-regenerate-confirm" role="group" aria-label={t.regenerate}>
      <p class="card-confirm-note">{t.regenerateCost}</p>
      <div class="card-confirm-buttons">
        <button type="button" class="button" data-variant="text" ref={cancel} onClick={onCancel}>
          {t.cancel}
        </button>
        <button type="button" class="button" data-variant="primary" onClick={onConfirm}>
          {t.regenerateConfirm}
        </button>
      </div>
    </div>
  );
}

/** 点了展开而内容还在读：最多等这么久再打开，读到了就直接从标题栏长到内容那么高，不先露一行「正在读取」。 */
export const OPEN_HOLD_MS = 500;

/**
 * 标题栏下面那一整块，展开收起用共用的 Collapse：高度有过渡，收起时内容留到过渡走完才拿掉。
 * 点了展开而内容还在读时先等一会儿。已经开着时换内容不关，高度照旧直接变：不是用户点出来的高度变化不逐帧报给播放页。
 */
function Fold({ collapsed, waiting, children }: { readonly collapsed: boolean; readonly waiting: boolean; readonly children: ComponentChildren }) {
  const [open, setOpen] = useState(!collapsed && !waiting);
  useLayoutEffect(() => {
    if (collapsed) return setOpen(false);
    if (!waiting) return setOpen(true);
    const timer = setTimeout(() => setOpen(true), OPEN_HOLD_MS);
    return () => clearTimeout(timer);
  }, [collapsed, waiting]);
  return (
    <Collapse open={open} outerClass="card-sheet" innerClass="card-sheet-in">
      {children}
    </Collapse>
  );
}

/** setupHint 说明 AI 服务还缺哪项设置。 */
/** ask 是这一次提问的状态（ask.ts），不给时当没问过。 */
export function Card({
  view,
  aiReady,
  setupHint,
  actions,
  ask = ASK_IDLE,
}: {
  readonly view: CardView;
  readonly aiReady: boolean | null;
  readonly setupHint: string;
  readonly actions: CardActions;
  readonly ask?: AskState;
}) {
  const moreButton = useRef<HTMLButtonElement>(null);
  const regenerateButton = useRef<HTMLButtonElement>(null);
  const officialClose = useRef<HTMLButtonElement>(null);
  const revealOfficial = useRef(false);
  const previousMore = useRef(view.more);
  const moreOpen = view.more !== "closed";

  useLayoutEffect(() => {
    if (previousMore.current === "confirm") {
      if (view.more === "actions") regenerateButton.current?.focus();
      if (view.more === "closed") moreButton.current?.focus();
    }
    previousMore.current = view.more;
  }, [view.more]);

  useLayoutEffect(() => {
    if (!moreOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      actions.toggleMore();
      moreButton.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [moreOpen, actions.toggleMore]);

  useLayoutEffect(() => {
    if (!revealOfficial.current) return;
    revealOfficial.current = false;
    // 只把卡片正文滚到官方总结，保持播放页的位置。
    const close = officialClose.current;
    const section = close?.closest("section");
    const body = section?.closest(".card-body");
    if (section && body) body.scrollTop += section.getBoundingClientRect().top - body.getBoundingClientRect().top;
    close?.focus({ preventScroll: true });
  }, [view.officialOpen]);

  if (!view.visible) return null;
  const task = view.task;
  const withOverview = hasOverview(view.analysis);
  const canGenerate = view.phase === "loaded" && !view.noCaptions && !view.needLogin && !view.notRead && !withOverview && !task;
  const needsSetup = aiReady === false && (canGenerate || canWriteFromOfficial(view, true));
  const analysis = view.analysis && (view.analysis.verdict || withOverview || view.verdictPending) ? view.analysis : null;
  const official = view.official?.status === "ok" ? view.official : null;
  const t = cardText();
  const officialNotes: Readonly<Partial<Record<OfficialSummaryView["status"], string>>> = t.officialNotes;
  // 没登录时上面已经说了要登录，官方总结那块不再重复。
  const officialNote = view.official && view.phase === "loaded" && !(view.needLogin && view.official.status === "need-login") ? (officialNotes[view.official.status] ?? "") : "";
  const percent = task && task.total > 0 ? Math.round((task.done / task.total) * 100) : 0;
  const glance = glanceOf(view);
  const showGenerate = !view.holdActions && canGenerate && !needsSetup;
  const showSettings = !view.holdActions && (needsSetup || (canGenerate && view.settingsError));
  const showStart = showGenerate || showSettings;
  const showRetry = !view.holdActions && !task && (view.phase === "failed" || view.needLogin || (view.notRead && !withOverview));
  const officialLink = canWriteFromOfficial(view, aiReady) ? (
    <button type="button" class="card-link" id="card-official-verdict" onClick={actions.fromOfficial}>{t.verdictFromOfficial}</button>
  ) : null;
  const retryHint = view.needLogin ? t.needLogin : view.notRead ? t.notRead : "";
  const offerHint = view.noCaptions && !withOverview && officialLink ? t.noCaptions : "";
  const statusText = view.notice?.text ?? (showRetry ? retryHint : offerHint);
  const canRedo = view.phase === "loaded" && aiReady === true && !task && withOverview && !view.noCaptions && !view.needLogin && !view.notRead;
  const toggleOfficial = (): void => {
    revealOfficial.current = !view.officialOpen;
    if (view.officialOpen) moreButton.current?.focus();
    actions.toggleOfficial();
  };
  return (
    <div class="card" id="card" data-collapsed={view.collapsed ? "true" : "false"} data-band={bandOf(glance.label)}>
      <div class="card-head-row">
        <button type="button" class="card-head" id="card-toggle" aria-expanded={!view.collapsed} aria-controls="card-body" title={view.collapsed ? t.expand : t.collapse} onClick={actions.toggle}>
          <img class="card-logo" src="../icons/icon-32.png" width="16" height="16" alt="" aria-hidden="true" />
          <span class={glance.label ? "card-name sr-only" : "card-name"}>{t.name}</span>
          {glance.label ? <VerdictLabel class="card-verdict" rating={glance.label} /> : null}
          {glance.text ? (
            <span class="card-glance" id="card-glance" role={view.headNote ? "status" : undefined}>
              {glance.text}
            </span>
          ) : null}
          <span class="card-collapse" aria-hidden="true">
            <Icon name="chevron" />
          </span>
        </button>
        {!view.panelOpen ? (
          <button type="button" class="card-head-panel" id="card-panel" title={t.openPanel} onClick={actions.openPanel}>
            {t.headPanel}
          </button>
        ) : null}
        {!view.collapsed ? (
          <button
            type="button" class="card-head-more" id="card-more-actions" ref={moreButton}
            aria-label={t.moreActions} title={t.moreActions} aria-expanded={moreOpen}
            aria-controls={moreOpen ? "card-tools" : undefined} onClick={actions.toggleMore}
          >
            <Icon name="more" />
          </button>
        ) : null}
      </div>
      <Collapse open={moreOpen} outerClass="card-tools-sheet">
        <div class="card-tools" id="card-tools" role="group" aria-label={t.moreActions}>
          {view.more === "confirm" && canRedo ? (
            <RegenerateConfirm onConfirm={actions.regenerate} onCancel={actions.askRegenerate} />
          ) : (
            <>
              {canRedo && !view.holdActions ? (
                <button type="button" id="card-regenerate" ref={regenerateButton} onClick={actions.askRegenerate}>
                  {t.regenerate}<small>{t.regenerateNote}</small>
                </button>
              ) : null}
              {withOverview && official ? (
                <button type="button" aria-expanded={view.officialOpen} aria-controls={view.officialOpen ? "card-official" : undefined} id="card-toggle-official" onClick={toggleOfficial}>
                  {t.official}
                </button>
              ) : null}
              <button type="button" onClick={actions.openSettings}>{t.settings}</button>
            </>
          )}
        </div>
      </Collapse>
      <Fold collapsed={view.collapsed} waiting={view.phase === "loading"}>
        {task ? (
          <div class="card-progress" id="card-progress">
            <div class="card-track" aria-hidden="true">
              <div class="card-bar" style={{ transform: `scaleX(${percent / 100})` }} />
            </div>
            <span class="card-progress-text" role="status">{progressText(task, view.verdictPending)}</span>
            <button type="button" class="button" data-variant="text" disabled={task.canceling} onClick={actions.cancel}>
              {t.stop}
            </button>
          </div>
        ) : null}
        <div class="card-body" id="card-body">
          {showStart ? (
            <div class="card-offer" id="card-start">
              {needsSetup ? <span class="card-note" id="card-setup">{setupHint}</span> : null}
              {showGenerate ? <button type="button" class="button" data-variant="primary" id="card-generate" onClick={actions.generate}>{t.generate}</button> : null}
              {showSettings ? <button type="button" class="button" data-variant={needsSetup ? "primary" : "secondary"} id="card-settings" onClick={actions.openSettings}>{t.openSettings}</button> : null}
              {officialLink}
            </div>
          ) : null}
          {statusText || showRetry || (!showStart && officialLink) ? (
            <p class="card-note">
              {statusText ? <span class="card-status" id="card-status" role="status" data-tone={view.notice?.tone || undefined}>{statusText}</span> : null}{" "}
              {showRetry ? <button type="button" class="card-link" id="card-retry" onClick={actions.retry}>{t.retry}</button> : null}
              {!showStart && officialLink}
            </p>
          ) : null}
          <ServiceSaid said={view.notice?.said} />
          {analysis ? (
            <Overview
              analysis={analysis}
              stale={staleOverviewMarks(view.transcriptBasis ?? undefined, view.transcriptFingerprint, !view.verdictPending && text(analysis.verdict?.summary) !== "")}
              pending={Boolean(view.verdictPending || task)}
              commentsOpen={view.commentsOpen}
              onToggleComments={actions.toggleComments}
              onSeek={actions.seek}
            />
          ) : null}
          {official && (!withOverview || view.officialOpen) ? (
            <section class="card-block" id="card-official" aria-label={t.official}>
              <div class="card-official-head">
                <h2 class="section-title">{t.official}</h2>
                {withOverview ? <button type="button" class="card-link" ref={officialClose} onClick={toggleOfficial}>{t.less}</button> : null}
              </div>
              <OfficialBody official={official} limited={!withOverview && !view.showAll} onSeek={actions.seek} {...(withOverview ? { chapters: analysis?.chapters } : { onToggleAll: actions.toggleShowAll })} />
            </section>
          ) : officialNote ? (
            <p class="card-note">{officialNote}</p>
          ) : null}
          {canRedo && view.failedParts > 0 ? (
            <p class="card-note" id="card-failed-parts">
              {t.failedParts}{" "}<button type="button" class="card-link" onClick={actions.retryFailed}>{t.retryFailed}</button>
            </p>
          ) : null}
          {(view.phase === "loaded" && aiReady === true && view.canAsk) || ask.phase !== "idle" ? <CardAskBox state={ask} onAsk={actions.ask} onCancel={actions.cancelAsk} onSeek={actions.seek} /> : null}
        </div>
      </Fold>
    </div>
  );
}
