// 精读：上面一条当前章节，跟着播放走；下面是跟着播放滚动、高亮当前句的字幕，能搜索、翻译、划词解释。
// 当前章节和字幕的工具行都吸在顶上那一层下面，看到哪都够得着。
// 章节用模型生成的概览（结论标了重点的这一章，读屏读一次「重点」），没有时用 UP 主分段，都没有时不显示这一条。
// 当前章节条的样子由主题样式表定：同一份标记里带着各套主题要用的部分（章节数、「第几章，共几章，几点开始」那一行、
// 判断档、按章节时长分段的进度条、播放进度条），样式表决定这一套显示哪些；画出来的进度都不进读屏。
import { keyChapterStarts, verdictLabelOf, type VerdictRating } from "../../core/ai/verdict.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { VerdictLabel } from "../shared/ui/verdict-block.tsx";
import { chapterLengths, knownLength } from "../shared/ui/chapters.ts";
import { bandOf } from "../shared/ui/verdict.ts";
import { sharedText } from "../shared/text.ts";
import type { Panel } from "./panel.ts";
import { chapterAt } from "./reading.ts";
import { useStickyHeight } from "./sticky.ts";
import { panelText } from "./text.ts";
import { TranscriptTab } from "./transcript-tab.tsx";

interface BarChapter {
  readonly startSec: number;
  readonly title: string;
  /** 结论里标的重点章节。 */
  readonly key?: boolean;
}

function chaptersOf(panel: Panel): readonly BarChapter[] {
  const overview = panel.overview.state.value;
  const analysis = overview.task && overview.preview ? overview.preview.analysis : overview.saved?.analysis;
  const keys = new Set(keyChapterStarts(analysis));
  const generated = (analysis?.chapters ?? [])
    .filter((chapter) => Number.isFinite(chapter.timestampSeconds))
    .map((chapter) => ({
      startSec: chapter.timestampSeconds,
      title: typeof chapter.title === "string" ? chapter.title.trim() : "",
      key: keys.has(Math.floor(chapter.timestampSeconds)),
    }));
  if (generated.length > 0) return [...generated].sort((a, b) => a.startSec - b.startSec);
  const now = panel.transcript.state.value;
  const creator = now.state === "ready" ? now.view.chapters : now.state === "failed" ? (now.failure.chapters ?? []) : [];
  return creator.map((chapter) => ({ startSec: chapter.start, title: chapter.title.trim() }));
}

/** 这个视频的判断档：有写好的结论才有。 */
function verdictOf(panel: Panel): VerdictRating | "" {
  const saved = panel.overview.state.value.saved?.analysis.verdict;
  return typeof saved?.summary === "string" && saved.summary.trim() ? verdictLabelOf(saved.verdict) : "";
}

const percent = (share: number): string => `${(Math.min(1, Math.max(0, share)) * 100).toFixed(2)}%`;

function ChapterBar({ panel }: { readonly panel: Panel }) {
  const chapters = chaptersOf(panel);
  const { video } = panel.follow.target.value;
  const position = panel.player.position.value;
  const at = position && position.video === video ? position.atSec : null;
  const index = chapterAt(chapters, at);
  const chapter = chapters[index];
  const ref = useStickyHeight<HTMLDivElement>("--chapter-bar-h", Boolean(chapter));
  if (!chapter) return null;
  const now = panel.transcript.state.value;
  const total = now.state === "ready" ? now.view.info.durationSec : now.state === "failed" ? now.failure.info?.durationSec : undefined;
  const length = knownLength(total) ? total : null;
  const lengths = chapterLengths(chapters, length);
  const time = formatTimestamp(chapter.startSec);
  const rating = verdictOf(panel);
  const t = panelText().study;
  return (
    <div class="chapter-bar" ref={ref} aria-label={t.currentChapter} data-band={bandOf(rating)}>
      <div class="chapter-bar-row">
        {rating ? <VerdictLabel class="chapter-bar-verdict" rating={rating} /> : null}
        <span class="chapter-bar-count">
          {index + 1}/{chapters.length}
        </span>
        <span class="chapter-bar-main">
          <button type="button" class="chapter-bar-place" aria-label={t.jumpToChapter(time)} onClick={() => void panel.seek(chapter.startSec)}>
            {t.place(index + 1, chapters.length, time)}
          </button>
          {/* 播到下一章时换上来的章节名淡进来。 */}
          <span key={index} class="chapter-bar-title">
            {chapter.key ? <span class="sr-only">{`${sharedText().chapters.key} `}</span> : null}
            {chapter.title || time}
          </span>
        </span>
        <button type="button" class="stamp chapter-bar-time" aria-label={t.jumpToChapter(time)} onClick={() => void panel.seek(chapter.startSec)}>
          {time}
        </button>
      </div>
      {length !== null && at !== null ? (
        <>
          <span class="chapter-strip" aria-hidden="true">
            {lengths.map((span, piece) => (
              <i key={piece} class="chapter-strip-piece" data-current={piece === index ? "true" : undefined} style={`flex-grow:${span ?? 0}`} />
            ))}
            <span class="chapter-strip-head" style={`left:${percent(at / length)}`} />
          </span>
          <span class="chapter-progress" aria-hidden="true">
            <span class="chapter-progress-fill" style={`width:${percent(at / length)}`} />
          </span>
        </>
      ) : null}
    </div>
  );
}

export function StudyView({ panel }: { readonly panel: Panel }) {
  return (
    <div class="study">
      <ChapterBar panel={panel} />
      <TranscriptTab panel={panel} />
    </div>
  );
}
