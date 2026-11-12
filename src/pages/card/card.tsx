// 卡片的界面：标题栏（展开收起）、官方总结、概览（结论和章节）、进度和按钮。规则在 model.ts。
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { OfficialSummaryView, OutlineSectionView } from "../../shared/messages/transcript.ts";
import { ChapterList, type ChapterItem } from "../shared/ui/chapter-list.tsx";
import { VerdictBlock } from "../shared/ui/verdict-block.tsx";
import type { BasisSource } from "../shared/ui/verdict.ts";
import { hasOverview, type CardView } from "./model.ts";

const SETUP_HINT = "还没设置 AI 服务（或没勾选数据说明、密钥已随浏览器重启清空），生成概览要先填服务商和密钥。";

const OFFICIAL_MISSING: Readonly<Record<OfficialSummaryView["status"], string>> = {
  ok: "",
  none: "B 站没有给这个视频做官方总结。",
  unsupported: "B 站没有给这个视频做官方总结。",
  queued: "B 站的官方总结还在生成，过一会儿再来看。",
  "need-login": "登录 B 站后才看得到官方总结。",
  failed: "这次没读到 B 站的官方总结。",
  pending: "正在读 B 站的官方总结…",
};

type ClickEvent = { readonly isTrusted: boolean };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function TimeButton({ atSec, onSeek }: { readonly atSec: number | null; readonly onSeek: (atSec: number) => void }) {
  if (atSec === null || !Number.isFinite(atSec) || atSec < 0) return null;
  return (
    <button type="button" class="chapter-time" title="跳到这里" onClick={() => onSeek(atSec)}>
      {formatTimestamp(atSec)}
    </button>
  );
}

function OutlineItem({ part, index, onSeek }: { readonly part: OutlineSectionView; readonly index: number; readonly onSeek: (atSec: number) => void }) {
  const title = part.title.trim() || `第 ${index + 1} 段`;
  const points = part.points.filter((point) => point.content.trim());
  return (
    <li class="outline-item">
      <TimeButton atSec={part.timestamp} onSeek={onSeek} />
      {points.length ? (
        <details class="outline-details">
          <summary class="outline-title">{title}</summary>
          <ul class="points">
            {points.map((point, at) => (
              <li key={at} class="point">
                <TimeButton atSec={point.timestamp} onSeek={onSeek} />
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

function Official({ official, onSeek }: { readonly official: OfficialSummaryView; readonly onSeek: (atSec: number) => void }) {
  return (
    <section class="card-block" id="card-official" aria-label="B 站官方总结">
      <h2 class="section-title">B 站官方总结</h2>
      {official.summary.trim() ? <p class="card-reading">{official.summary.trim()}</p> : null}
      {official.outline.length ? (
        <ol class="outline">
          {official.outline.map((part, index) => (
            <OutlineItem key={index} part={part} index={index} onSeek={onSeek} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function basisOf(analysis: LearningAnalysis): BasisSource | null {
  const source = text(analysis.verdict?.source);
  if (source === "official" || source === "official-summary") return "official-summary";
  return hasOverview(analysis) ? "transcript" : null;
}

function Overview({ analysis, pending, onSeek }: { readonly analysis: LearningAnalysis; readonly pending: boolean | string; readonly onSeek: (atSec: number) => void }) {
  const verdict = analysis.verdict;
  const summary = text(verdict?.summary);
  const chapters: ChapterItem[] = (analysis.chapters ?? []).map((chapter) => ({ startSec: chapter.timestampSeconds, title: text(chapter.title) }));
  return (
    <section class="card-block" id="card-overview" aria-label="AI 概览">
      <h2 class="section-title">AI 概览</h2>
      {pending ? (
        <p class="card-pending" role="status">
          {typeof pending === "string" ? pending : "正在写一句话结论…"}
        </p>
      ) : summary ? (
        <VerdictBlock label={text(verdict?.verdict)} text={summary} basis={basisOf(analysis)} incomplete={verdict?.incomplete === true} />
      ) : null}
      {chapters.length ? <ChapterList chapters={chapters} heading={false} onSeek={onSeek} /> : null}
    </section>
  );
}

export interface CardActions {
  readonly toggle: () => void;
  readonly generate: (event: ClickEvent) => void;
  readonly cancel: () => void;
  readonly retry: () => void;
  readonly openPanel: (event: ClickEvent) => void;
  readonly openSettings: (event: ClickEvent) => void;
  readonly seek: (atSec: number) => void;
}

export function Card({ view, aiReady, actions }: { readonly view: CardView; readonly aiReady: boolean | null; readonly actions: CardActions }) {
  if (!view.visible) return null;
  const canGenerate = view.phase === "loaded" && !view.noCaptions && !hasOverview(view.analysis) && !view.task;
  const needsSetup = canGenerate && aiReady === false;
  const official = view.official;
  const officialMissing = official && official.status !== "ok" ? OFFICIAL_MISSING[official.status] : "";
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
          {view.title ? <p class="card-video-title">{view.title}</p> : null}
          {view.notice ? (
            <p class="card-status" id="card-status" role="status" data-tone={view.notice.tone || undefined}>
              {view.notice.text}
            </p>
          ) : null}
          {official?.status === "ok" ? <Official official={official} onSeek={actions.seek} /> : officialMissing && view.phase === "loaded" ? <p class="card-note">{officialMissing}</p> : null}
          {view.analysis && (view.analysis.verdict || hasOverview(view.analysis) || view.verdictPending) ? <Overview analysis={view.analysis} pending={view.verdictPending} onSeek={actions.seek} /> : null}
          {needsSetup ? <p class="card-note" id="card-setup">{SETUP_HINT}</p> : null}
        </div>
      )}
      {task && !view.collapsed ? (
        <div class="card-progress" id="card-progress" role="status">
          <div class="card-track">
            <div class="card-bar" style={{ width: `${percent}%` }} />
          </div>
          <span class="card-progress-text">{task.canceling ? "正在停止…" : task.message || (task.total > 0 ? `${task.done}/${task.total} 块完成` : "正在准备…")}</span>
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
          {view.phase === "failed" && !task ? (
            <button type="button" class="button" id="card-retry" onClick={actions.retry}>
              重试
            </button>
          ) : null}
          <button type="button" class="button" id="card-panel" onClick={actions.openPanel}>
            打开完整面板
          </button>
        </div>
      )}
    </div>
  );
}
