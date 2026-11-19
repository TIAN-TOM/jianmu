// 卡片的界面：标题栏（展开收起）、提示、AI 概览（结论在最前，章节默认只露前几章）、B 站官方总结（有概览时收成一行）、进度和按钮。
// 规则在 model.ts。视频标题不在卡片里再写一遍：页面顶上就是。
import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { OfficialSummaryView, OutlineSectionView } from "../../shared/messages/transcript.ts";
import { keyChapterStarts } from "../../core/ai/verdict.ts";
import { ChapterList, type ChapterItem } from "../shared/ui/chapter-list.tsx";
import { VerdictBlock } from "../shared/ui/verdict-block.tsx";
import type { BasisSource } from "../shared/ui/verdict.ts";
import { cardRows, hasOverview, type CardView, type TaskProgress } from "./model.ts";

// 没有官方总结是常态，不占一行；要登录、没读到、还在读才说。
const OFFICIAL_NOTES: Readonly<Partial<Record<OfficialSummaryView["status"], string>>> = {
  "need-login": "登录 B 站后才看得到官方总结。",
  failed: "这次没读到 B 站的官方总结。",
  pending: "正在读 B 站的官方总结…",
};

type ClickEvent = { readonly isTrusted: boolean };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const validTime = (atSec: number | null): atSec is number => atSec !== null && Number.isFinite(atSec) && atSec >= 0;

/** 时间这一列按最长的那个时间定宽，后面的标题才对得齐。 */
const timeColumn = (times: readonly (number | null)[]): string => `--time-ch:${Math.max(4, ...times.map((at) => (validTime(at) ? formatTimestamp(at).length : 0)))}`;

function TimeCell({ atSec, onSeek }: { readonly atSec: number | null; readonly onSeek: (atSec: number) => void }) {
  return (
    <span class="outline-time">
      {validTime(atSec) ? (
        <button type="button" class="chapter-time" aria-label={`跳到 ${formatTimestamp(atSec)}`} onClick={() => onSeek(atSec)}>
          {formatTimestamp(atSec)}
        </button>
      ) : null}
    </span>
  );
}

function OutlineItem({ part, index, onSeek }: { readonly part: OutlineSectionView; readonly index: number; readonly onSeek: (atSec: number) => void }) {
  const title = part.title.trim() || `第 ${index + 1} 段`;
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
      {open ? "收起" : label}
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
      {onToggleAll && (!limited || outlineCut || clipped) ? <More open={!limited} label={outlineCut ? `展开全部 ${official.outline.length} 段` : "展开全部"} onToggle={onToggleAll} /> : null}
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
  pending,
  showAll,
  onSeek,
  onToggleAll,
}: {
  readonly analysis: LearningAnalysis;
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
  return (
    <section class="card-block" id="card-overview" aria-label="AI 概览">
      {pending ? (
        <p class="card-pending" role="status">
          {typeof pending === "string" ? pending : "正在写一句话结论…"}
        </p>
      ) : summary ? (
        <VerdictBlock label={text(verdict?.verdict)} text={summary} basis={basisOf(analysis)} incomplete={verdict?.incomplete === true} />
      ) : null}
      {shown.length ? <ChapterList chapters={shown} keyStarts={keyChapterStarts(analysis)} heading={false} onSeek={onSeek} /> : null}
      {cut ? <More open={showAll} label={`展开全部 ${chapters.length} 章`} onToggle={onToggleAll} /> : null}
    </section>
  );
}

function progressText(task: TaskProgress): string {
  if (task.canceling) return "正在停止…";
  const text = task.message || (task.total > 0 ? `${task.done}/${task.total} 块完成` : "");
  if (task.auto) return text ? `自动生成：${text}` : "正在自动生成概览…";
  return text || "正在准备…";
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

/** setupHint 是 AI 服务没设置好时生成概览按钮旁的说明，按缺什么说。 */
export function Card({ view, aiReady, setupHint, actions }: { readonly view: CardView; readonly aiReady: boolean | null; readonly setupHint: string; readonly actions: CardActions }) {
  if (!view.visible) return null;
  const canGenerate = view.phase === "loaded" && !view.noCaptions && !view.needLogin && !view.notRead && !hasOverview(view.analysis) && !view.task;
  // 本机还没有字幕：在侧边栏读过以后点重试，不用刷新页面就能生成。已经有概览时用不着。
  const retryRead = view.notRead && !hasOverview(view.analysis);
  const needsSetup = canGenerate && aiReady === false;
  const analysis = view.analysis && (view.analysis.verdict || hasOverview(view.analysis) || view.verdictPending) ? view.analysis : null;
  const official = view.official?.status === "ok" ? view.official : null;
  // 没登录时上面已经说了要登录，官方总结那块不再重复。
  const officialNote = view.official && view.phase === "loaded" && !(view.needLogin && view.official.status === "need-login") ? (OFFICIAL_NOTES[view.official.status] ?? "") : "";
  const task = view.task;
  const percent = task && task.total > 0 ? Math.round((task.done / task.total) * 100) : 0;
  return (
    <div class="card" id="card" data-collapsed={view.collapsed ? "true" : "false"}>
      <button type="button" class="card-head" id="card-toggle" aria-expanded={!view.collapsed} aria-controls="card-body" title={view.collapsed ? "展开总结卡片" : "收起总结卡片"} onClick={actions.toggle}>
        <span class="card-dot" aria-hidden="true" />
        <span class="card-name">简幕 · 总结</span>
        <span class="card-chevron" aria-hidden="true" />
      </button>
      {view.collapsed ? null : (
        <div class="card-body" id="card-body">
          {view.notice ? (
            <p class="card-status" id="card-status" role="status" data-tone={view.notice.tone || undefined}>
              {view.notice.text}
            </p>
          ) : null}
          {analysis ? <Overview analysis={analysis} pending={view.verdictPending} showAll={view.showAll} onSeek={actions.seek} onToggleAll={actions.toggleShowAll} /> : null}
          {official && analysis ? (
            // 已经有结论和章节：官方总结收成一行，点开才露。
            <section class="card-block" id="card-official" aria-label="B 站官方总结">
              <button type="button" class="card-fold-head" aria-expanded={view.officialOpen} aria-controls={view.officialOpen ? "card-official-body" : undefined} onClick={actions.toggleOfficial}>
                <span>B 站官方总结</span>
                <span class="card-chevron" aria-hidden="true" />
              </button>
              {view.officialOpen ? (
                <div class="card-fold-body" id="card-official-body">
                  <OfficialBody official={official} limited={false} onSeek={actions.seek} />
                </div>
              ) : null}
            </section>
          ) : official ? (
            <section class="card-block" id="card-official" aria-label="B 站官方总结">
              <h2 class="section-title">B 站官方总结</h2>
              <OfficialBody official={official} limited={!view.showAll} onSeek={actions.seek} onToggleAll={actions.toggleShowAll} />
            </section>
          ) : officialNote ? (
            <p class="card-note">{officialNote}</p>
          ) : null}
          {needsSetup ? <p class="card-note" id="card-setup">{setupHint}</p> : null}
        </div>
      )}
      {task && !view.collapsed ? (
        <div class="card-progress" id="card-progress" role="status">
          <div class="card-track">
            <div class="card-bar" style={{ width: `${percent}%` }} />
          </div>
          <span class="card-progress-text">{progressText(task)}</span>
          <button type="button" class="button" data-variant="text" disabled={task.canceling} onClick={actions.cancel}>
            停止
          </button>
        </div>
      ) : null}
      {view.collapsed ? null : (
        <div class="card-actions">
          {canGenerate && !needsSetup ? (
            <button type="button" class="button" data-variant="primary" id="card-generate" onClick={actions.generate}>
              生成概览
            </button>
          ) : null}
          {needsSetup || (canGenerate && view.settingsError) ? (
            <button type="button" class="button" data-variant={needsSetup ? "primary" : "secondary"} id="card-settings" onClick={actions.openSettings}>
              打开设置
            </button>
          ) : null}
          {(view.phase === "failed" || view.needLogin || retryRead) && !task ? (
            <button type="button" class="button" id="card-retry" onClick={actions.retry}>
              重试
            </button>
          ) : null}
          <button type="button" class="button" id="card-panel" onClick={actions.openPanel}>
            打开侧边栏
          </button>
        </div>
      )}
    </div>
  );
}
