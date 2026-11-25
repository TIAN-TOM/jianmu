// 精读：上面一条当前章节，跟着播放走；下面是跟着播放滚动、高亮当前句的字幕，能搜索、翻译、划词解释。
// 当前章节和字幕的工具行都吸在顶上那一层下面，看到哪都够得着。
// 章节用模型生成的概览（结论标了重点的这一章前面一个圆点），没有时用 UP 主分段，都没有时不显示这一条。
import { keyChapterStarts } from "../../core/ai/verdict.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
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

function ChapterBar({ panel }: { readonly panel: Panel }) {
  const chapters = chaptersOf(panel);
  const { video } = panel.follow.target.value;
  const position = panel.player.position.value;
  const at = position && position.video === video ? position.atSec : null;
  const index = chapterAt(chapters, at);
  const chapter = chapters[index];
  const ref = useStickyHeight<HTMLDivElement>("--chapter-bar-h", Boolean(chapter));
  if (!chapter) return null;
  const time = formatTimestamp(chapter.startSec);
  const t = panelText().study;
  return (
    <div class="chapter-bar" ref={ref} aria-label={t.currentChapter}>
      <span class="chapter-bar-count">
        {index + 1}/{chapters.length}
      </span>
      {chapter.key ? <span class="key-dot" role="img" aria-label={sharedText().chapters.key} /> : null}
      {/* 播到下一章时换上来的章节名淡进来。 */}
      <span key={index} class="chapter-bar-title">
        {chapter.title || time}
      </span>
      <button type="button" class="stamp" aria-label={t.jumpToChapter(time)} onClick={() => void panel.seek(chapter.startSec)}>
        {time}
      </button>
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
