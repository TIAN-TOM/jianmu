// 速览：一句话结论在最上面，然后是模型生成的章节，每章展开看要点、金句和这一段的字幕，再是视频网站的官方总结和 UP 主分段。
// 还没有概览时先摆官方总结和 UP 主分段，下面是「生成概览」和字幕。长视频边生成边显示，能停止、补失败块、重新生成；
// 没有结论时可以只用官方总结写一句。换过字幕时，依据旧字幕写的结论和章节标「基于旧字幕」，不删不改。
import { groupQuotesIntoChapters, type ChapterPart, type QuotePart } from "../../core/ai/chunking.ts";
import { keyChapterStarts } from "../../core/ai/verdict.ts";
import { learningAsMarkdown, type LearningAnalysis } from "../../core/notes/markdown.ts";
import { breaksToShow, lineBreaks, splitRuns } from "../../core/transcript/lines.ts";
import { formatTimestamp, type TranscriptSegment } from "../../core/transcript/segment.ts";
import type { CueView } from "../../shared/messages/transcript.ts";
import { useMemo, useState } from "preact/hooks";
import { Button } from "../shared/ui/button.tsx";
import { ChapterList } from "../shared/ui/chapter-list.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StaleTranscriptLine, VerdictBlock } from "../shared/ui/verdict-block.tsx";
import { staleOverviewMarks, type BasisSource } from "../shared/ui/verdict.ts";
import { BatchBar } from "./batch-bar.tsx";
import { downloadText, safeFileName, videoBaseOf } from "./files.ts";
import { CreatorChapters, OfficialSummary } from "./guides.tsx";
import type { Panel } from "./panel.ts";
import { segmentsBetween } from "./reading.ts";
import { TranscriptTab } from "./transcript-tab.tsx";
import { setupReason } from "../shared/config.ts";
import { sharedText } from "../shared/text.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { noteStored, panelText } from "./text.ts";

const BASIS: readonly BasisSource[] = ["transcript", "official-summary", "title-description", "legacy-unknown"];

const NO_SEGMENTS: readonly TranscriptSegment[] = [];
const NO_CUES: readonly CueView[] = [];

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function Quote({ panel, quote }: { readonly panel: Panel; readonly quote: QuotePart }) {
  const [saved, setSaved] = useState(false);
  const t = panelText().skim;
  return (
    <li class="quote">
      <button type="button" class="stamp" aria-label={sharedText().jumpTo(formatTimestamp(quote.timestampSeconds))} onClick={() => void panel.seek(quote.timestampSeconds)}>
        {formatTimestamp(quote.timestampSeconds)}
      </button>
      <span class="quote-text">{quote.quote}</span>
      <Button
        variant="text"
        disabled={saved}
        onClick={() =>
          void panel.notes.save(quote.timestampSeconds, quote.quote).then((result) => {
            setSaved(noteStored(result));
            panel.say(result);
          })
        }
      >
        {saved ? t.savedNote : t.saveAsNote}
      </Button>
    </li>
  );
}

function ChapterTranscript({ panel, segments, breaks }: { readonly panel: Panel; readonly segments: readonly TranscriptSegment[]; readonly breaks: ReadonlyMap<string, readonly number[]> }) {
  if (segments.length === 0) return null;
  return (
    <ol class="chapter-cues" aria-label={panelText().skim.chapterCues}>
      {segments.map((segment) => (
        <li key={segment.id} class="chapter-cue">
          <button type="button" class="stamp" aria-label={sharedText().jumpTo(formatTimestamp(segment.start))} onClick={() => void panel.seek(segment.start)}>
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
        <section class="guide" aria-label={panelText().skim.quotes}>
          <h3 class="section-title">{panelText().skim.quotes}</h3>
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

function Verdict({
  panel,
  analysis,
  canOffer,
  failures,
  stale,
}: {
  readonly panel: Panel;
  readonly analysis: LearningAnalysis | null;
  readonly canOffer: boolean;
  readonly failures: number;
  readonly stale: boolean;
}) {
  const { verdictTask } = panel.overview.state.value;
  const p = panelText();
  const verdict = analysis?.verdict;
  const summary = text(verdict?.summary);
  const source = text(verdict?.source);
  if (verdictTask) {
    return (
      <div class="progress-row" role="status">
        <span>{p.skim.writingVerdict}</span>
        <Button variant="text" onClick={() => void panel.overview.cancel(verdictTask.id)}>
          {p.stop}
        </Button>
      </div>
    );
  }
  if (summary) {
    return (
      <VerdictBlock
        label={text(verdict?.verdict)}
        text={summary}
        basis={BASIS.find((item) => item === source) ?? null}
        staleTranscript={stale}
        incomplete={failures > 0 || verdict?.incomplete === true}
      />
    );
  }
  if (!canOffer) return null;
  return (
    <div class="verdict-offer">
      <Button onClick={() => void panel.overview.verdictFromOfficial()} note={p.skim.verdictFromOfficialNote}>
        {p.skim.verdictFromOfficial}
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
  const notReady = ready ? undefined : setupReason(config, uiLang.value);
  const t = panelText().skim;
  const verdictShown = !state.verdictTask && text(state.saved?.analysis.verdict?.summary) !== "";
  const stale = staleOverviewMarks(state.saved?.transcriptBasis, view?.transcript.ref.fingerprint, verdictShown);
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
    if (!markdown) return panel.say(t.nothingToExport);
    downloadText(`${safeFileName(info?.title ?? "", t.studyFile)}.md`, markdown, "text/markdown");
  };

  return (
    <div class="overview skim">
      <BatchBar panel={panel} ready={ready} />
      <Verdict panel={panel} analysis={state.saved?.analysis ?? null} canOffer={ready && official?.status === "ok" && !running} failures={failures} stale={stale.verdict} />
      {running ? (
        <div class="progress-row" role="status">
          <span>{running.total > 0 ? t.generating(running.done, running.total) : running.message || t.generatingPlain}</span>
          <Button variant="text" onClick={() => void panel.overview.cancel(running.id)}>
            {t.stopGenerating}
          </Button>
        </div>
      ) : null}
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.error ? <ServiceSaid said={state.errorSaid} /> : null}
      {state.result?.failedChunks ? <p class="note-line">{t.failedChunks(state.result.failedChunks)}</p> : null}
      {state.result?.saveFailed ? <p class="note-line">{t.saveFailed}</p> : null}
      {state.result?.canceled ? <p class="note-line">{t.canceled(state.result.savedChunks ?? 0)}</p> : null}
      {hasOverview ? null : guides}
      <section class="ai-overview" aria-label={t.overviewLabel}>
        {stale.chapters && hasOverview && !running ? <StaleTranscriptLine /> : null}
        {analysis && hasOverview ? <Chapters panel={panel} analysis={analysis} segments={view?.transcript.segments ?? NO_SEGMENTS} cues={view?.transcript.cues ?? NO_CUES} /> : null}
        {!running && state.loaded ? (
          <div class="state-actions">
            {hasChapters ? (
              <>
                {failures > 0 ? (
                  <Button onClick={() => void panel.overview.retryFailed()} disabled={!ready} {...(notReady ? { disabledReason: notReady } : {})} note={t.retryFailedNote}>
                    {t.retryFailed}
                  </Button>
                ) : null}
                <Button variant="text" onClick={() => void panel.overview.generate(true)} disabled={!ready} {...(notReady ? { disabledReason: notReady } : {})}>
                  {t.regenerate}
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void panel.overview.generate(false)} disabled={!ready || transcript.state !== "ready"} {...(notReady ? { disabledReason: notReady } : transcript.state !== "ready" ? { disabledReason: t.needTranscript } : {})} note={t.generateNote}>
                {t.generate}
              </Button>
            )}
            <Button variant="text" onClick={exportLearning}>
              {t.exportStudy}
            </Button>
          </div>
        ) : null}
      </section>
      {hasOverview ? guides : null}
      {!hasOverview && !running ? (
        <section class="skim-transcript" aria-label={t.transcriptLabel}>
          {/* 速览里的字幕不跟着播放滚动：不然整个侧边栏会被拉过结论和导读。 */}
          <TranscriptTab panel={panel} guides={false} follow={false} />
        </section>
      ) : null}
    </div>
  );
}
