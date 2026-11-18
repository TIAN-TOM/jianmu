// 速览：一句话结论在最上面，然后是模型生成的章节，每章展开看要点、金句和这一段的字幕，再是视频网站的官方总结和 UP 主分段。
// 还没有概览时先摆官方总结和 UP 主分段，下面是「生成概览」和字幕。长视频边生成边显示，能停止、补失败块、重新生成；
// 没有结论时可以只用官方总结写一句。
import { groupQuotesIntoChapters, type ChapterPart, type QuotePart } from "../../core/ai/chunking.ts";
import { keyChapterStarts } from "../../core/ai/verdict.ts";
import { learningAsMarkdown, type LearningAnalysis } from "../../core/notes/markdown.ts";
import { breaksToShow, lineBreaks, splitRuns } from "../../core/transcript/lines.ts";
import { formatTimestamp, type TranscriptSegment } from "../../core/transcript/segment.ts";
import type { CueView } from "../../shared/messages/transcript.ts";
import { useMemo, useState } from "preact/hooks";
import { Button } from "../shared/ui/button.tsx";
import { ChapterList } from "../shared/ui/chapter-list.tsx";
import { VerdictBlock } from "../shared/ui/verdict-block.tsx";
import type { BasisSource } from "../shared/ui/verdict.ts";
import { BatchBar } from "./batch-bar.tsx";
import { downloadText, safeFileName, videoBaseOf } from "./files.ts";
import { CreatorChapters, OfficialSummary } from "./guides.tsx";
import type { Panel } from "./panel.ts";
import { segmentsBetween } from "./reading.ts";
import { TranscriptTab } from "./transcript-tab.tsx";
import { setupReason } from "../shared/config.ts";

const BASIS: readonly BasisSource[] = ["transcript", "official-summary", "title-description", "legacy-unknown"];

const NO_SEGMENTS: readonly TranscriptSegment[] = [];
const NO_CUES: readonly CueView[] = [];

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function Quote({ panel, quote }: { readonly panel: Panel; readonly quote: QuotePart }) {
  const [saved, setSaved] = useState("");
  return (
    <li class="quote">
      <button type="button" class="stamp" aria-label={`跳到 ${formatTimestamp(quote.timestampSeconds)}`} onClick={() => void panel.seek(quote.timestampSeconds)}>
        {formatTimestamp(quote.timestampSeconds)}
      </button>
      <span class="quote-text">{quote.quote}</span>
      <Button
        variant="text"
        disabled={saved !== ""}
        onClick={() =>
          void panel.notes.save(quote.timestampSeconds, quote.quote).then((result) => {
            setSaved(result === "已存为笔记" || result.startsWith("这个时间点") ? "已保存" : "");
            panel.say(result);
          })
        }
      >
        {saved || "存为笔记"}
      </Button>
    </li>
  );
}

function ChapterTranscript({ panel, segments, breaks }: { readonly panel: Panel; readonly segments: readonly TranscriptSegment[]; readonly breaks: ReadonlyMap<string, readonly number[]> }) {
  if (segments.length === 0) return null;
  return (
    <ol class="chapter-cues" aria-label="这一段的字幕">
      {segments.map((segment) => (
        <li key={segment.id} class="chapter-cue">
          <button type="button" class="stamp" aria-label={`跳到 ${formatTimestamp(segment.start)}`} onClick={() => void panel.seek(segment.start)}>
            {formatTimestamp(segment.start)}
          </button>
          <span class="chapter-cue-text">
            {splitRuns([{ text: segment.text }], breaksToShow(segment, breaks)).map((line, index) => (
              <span key={index} class="cue-line">
                {line.map((run) => run.text).join("")}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Chapters({ panel, analysis, segments, cues }: { readonly panel: Panel; readonly analysis: LearningAnalysis; readonly segments: readonly TranscriptSegment[]; readonly cues: readonly CueView[] }) {
  const breaks = useMemo(() => lineBreaks(segments, cues), [segments, cues]);
  const [expanded, setExpanded] = useState<readonly number[]>([]);
  const chapters = (analysis.chapters ?? []).filter((chapter): chapter is ChapterPart => Number.isFinite(chapter.timestampSeconds));
  const quotes = (analysis.keyQuotes ?? []).filter((quote) => text(quote.quote));
  const { grouped, orphans: loose } = groupQuotesIntoChapters(chapters, quotes);
  const groups = grouped.map((group) => group.quotes);
  return (
    <>
      {chapters.length > 0 ? (
        <ChapterList
          keyStarts={keyChapterStarts(analysis)}
          chapters={chapters.map((chapter) => ({ startSec: chapter.timestampSeconds, title: text(chapter.title) || formatTimestamp(chapter.timestampSeconds) }))}
          expanded={expanded}
          onToggle={(index) => setExpanded(expanded.includes(index) ? expanded.filter((item) => item !== index) : [...expanded, index])}
          onSeek={(at) => void panel.seek(at)}
          renderDetail={(_, index) => (
            <>
              {text(chapters[index]?.summary) ? <p class="chapter-summary">{text(chapters[index]?.summary)}</p> : null}
              {groups[index]?.length ? (
                <ul class="quotes">
                  {groups[index]?.map((quote) => <Quote key={quote.quote} panel={panel} quote={quote} />)}
                </ul>
              ) : null}
              <ChapterTranscript panel={panel} breaks={breaks} segments={segmentsBetween(segments, chapters[index]?.timestampSeconds ?? 0, chapters[index + 1]?.timestampSeconds ?? null)} />
            </>
          )}
        />
      ) : null}
      {loose.length > 0 ? (
        <section class="guide" aria-label="金句">
          <h3 class="section-title">金句</h3>
          <ul class="quotes">
            {loose.map((quote) => (
              <Quote key={quote.quote} panel={panel} quote={quote} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Verdict({ panel, analysis, canOffer, failures }: { readonly panel: Panel; readonly analysis: LearningAnalysis | null; readonly canOffer: boolean; readonly failures: number }) {
  const { verdictTask } = panel.overview.state.value;
  const verdict = analysis?.verdict;
  const summary = text(verdict?.summary);
  const source = text(verdict?.source);
  if (verdictTask) {
    return (
      <div class="progress-row" role="status">
        <span>正在写一句话结论…</span>
        <Button variant="text" onClick={() => void panel.overview.cancel(verdictTask.id)}>
          停止
        </Button>
      </div>
    );
  }
  if (summary) {
    return <VerdictBlock label={text(verdict?.verdict)} text={summary} basis={BASIS.find((item) => item === source) ?? null} incomplete={failures > 0 || verdict?.incomplete === true} />;
  }
  if (!canOffer) return null;
  return (
    <div class="verdict-offer">
      <Button onClick={() => void panel.overview.verdictFromOfficial()} note="只发一次小请求，不通读字幕">
        用官方总结写结论
      </Button>
    </div>
  );
}

export function SkimView({ panel }: { readonly panel: Panel }) {
  const state = panel.overview.state.value;
  const transcript = panel.transcript.state.value;
  const config = panel.config.state.value;
  const ready = config.state === "checked" && config.view.ready;
  const view = transcript.state === "ready" ? transcript.view : null;
  const official = view?.official ?? (transcript.state === "failed" ? transcript.failure.official : undefined);
  const chapters = view?.chapters ?? (transcript.state === "failed" ? transcript.failure.chapters : undefined);
  const info = view?.info ?? (transcript.state === "failed" ? transcript.failure.info : undefined);
  const running = state.task;
  const analysis = running && state.preview ? state.preview.analysis : (state.saved?.analysis ?? null);
  const failures = state.saved?.analysisFailures.length ?? 0;
  const hasChapters = Boolean(analysis?.chapters?.length);
  const hasOverview = Boolean(analysis && (hasChapters || analysis.keyQuotes?.length));
  const notReady = ready ? undefined : setupReason(config);
  const seek = (at: number): void => void panel.seek(at);
  const guides = (
    <>
      <OfficialSummary official={official} onSeek={seek} />
      <CreatorChapters chapters={chapters} onSeek={seek} />
    </>
  );

  const exportLearning = (): void => {
    const notes = panel.notes.state.peek();
    const markdown = learningAsMarkdown(
      {
        title: info?.title ?? "",
        author: info?.author ?? "",
        ...(state.video ? { videoKey: state.video } : {}),
        exportedAt: Date.now(),
        analysis: state.saved?.analysis ?? null,
        analysisFailures: state.saved?.analysisFailures ?? [],
        officialSummary: official?.status === "ok" ? official : null,
        creatorChapters: chapters ?? [],
        notes: notes.scope === "video" ? notes.notes : [],
      },
      videoBaseOf(state.video),
    );
    if (!markdown) return panel.say("还没有可以导出的内容");
    downloadText(`${safeFileName(info?.title ?? "", "学习稿")}.md`, markdown, "text/markdown");
  };

  return (
    <div class="overview skim">
      <BatchBar panel={panel} ready={ready} />
      <Verdict panel={panel} analysis={state.saved?.analysis ?? null} canOffer={ready && official?.status === "ok" && !running} failures={failures} />
      {running ? (
        <div class="progress-row" role="status">
          <span>{running.total > 0 ? `正在生成概览 ${running.done}/${running.total} 块` : running.message || "正在生成概览…"}</span>
          <Button variant="text" onClick={() => void panel.overview.cancel(running.id)}>
            停止生成
          </Button>
        </div>
      ) : null}
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.result?.failedChunks ? <p class="note-line">有 {state.result.failedChunks} 块没生成成功，可以只补这几块。</p> : null}
      {state.result?.saveFailed ? <p class="note-line">概览已经生成，但没能存进本机。</p> : null}
      {state.result?.canceled ? <p class="note-line">停在中途，已完成的 {state.result.savedChunks ?? 0} 块存下了。</p> : null}
      {hasOverview ? null : guides}
      <section class="ai-overview" aria-label="模型生成的概览">
        {analysis && hasOverview ? <Chapters panel={panel} analysis={analysis} segments={view?.transcript.segments ?? NO_SEGMENTS} cues={view?.transcript.cues ?? NO_CUES} /> : null}
        {!running && state.loaded ? (
          <div class="state-actions">
            {hasChapters ? (
              <>
                {failures > 0 ? (
                  <Button onClick={() => void panel.overview.retryFailed()} disabled={!ready} {...(notReady ? { disabledReason: notReady } : {})} note="只补失败的时间段">
                    补失败块
                  </Button>
                ) : null}
                <Button variant="text" onClick={() => void panel.overview.generate(true)} disabled={!ready} {...(notReady ? { disabledReason: notReady } : {})}>
                  重新生成
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void panel.overview.generate(false)} disabled={!ready || transcript.state !== "ready"} {...(notReady ? { disabledReason: notReady } : transcript.state !== "ready" ? { disabledReason: "要先读到字幕" } : {})} note="把整段字幕交给模型，产出章节和金句">
                生成概览
              </Button>
            )}
            <Button variant="text" onClick={exportLearning}>
              导出学习稿
            </Button>
          </div>
        ) : null}
      </section>
      {hasOverview ? guides : null}
      {!hasOverview && !running ? (
        <section class="skim-transcript" aria-label="字幕">
          {/* 速览里的字幕不跟着播放滚动：不然整个侧边栏会被拉过结论和导读。 */}
          <TranscriptTab panel={panel} guides={false} follow={false} />
        </section>
      ) : null}
    </div>
  );
}
