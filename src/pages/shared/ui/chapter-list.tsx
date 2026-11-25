// 章节列表：时间是单独的按钮（跳到这一章），章节名展开要点和字幕。重点章节读屏在章节名前读一次「重点」。
// 重点画出来的样子由主题样式表定：同一份标记里带着各套主题要用的钩子（时间前的小播放键、章节名后的「重点」标签、
// 章节名下面按时长画的时长条），样式表决定这一套显示哪个，都不进读屏。
// 展开的内容由页面给；不给就只是一行时间加章节名。展开收起有高度过渡，收着的章节不算内容。
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { formatTimestamp } from "../../../core/transcript/segment.ts";
import { sharedText } from "../text.ts";
import { uiLang } from "../ui-lang.ts";
import { chapterHeading, chapterLengths, keyFlags, knownLength, lengthShares, totalLengthText } from "./chapters.ts";
import { Collapse } from "./collapse.tsx";
import { Icon } from "./icon.tsx";

export interface ChapterItem {
  readonly startSec: number;
  readonly title: string;
  /** 这一章在哪结束。不给就到下一章开始，最后一章到视频结束。 */
  readonly endSec?: number;
}

export interface ChapterListProps {
  readonly chapters: readonly ChapterItem[];
  readonly keyStarts?: readonly number[] | undefined;
  /** 视频总时长（秒）。知道的话小标题旁边写全长，最后一章的时长也按它算。 */
  readonly totalSec?: number | null | undefined;
  /** 展开着的章节序号。 */
  readonly expanded?: readonly number[];
  readonly onToggle?: (index: number) => void;
  readonly onSeek?: (startSec: number) => void;
  /** 悬停或当前章节，和时间轨同一个序号。 */
  readonly focusIndex?: number | null;
  readonly onHover?: (index: number | null) => void;
  readonly renderDetail?: (chapter: ChapterItem, index: number) => ComponentChildren;
  /** 显示「章节 6，重点 2」这一行小标题。 */
  readonly heading?: boolean;
}

export function ChapterList({ chapters, keyStarts, totalSec, expanded = [], onToggle, onSeek, focusIndex = null, onHover, renderDetail, heading = true }: ChapterListProps) {
  const id = useId();
  const t = sharedText();
  const keys = keyFlags(chapters, keyStarts);
  const keyCount = keys.filter(Boolean).length;
  const shares = lengthShares(chapterLengths(chapters, totalSec));
  // 时间这一列按最长的时间定宽，章节名才对得齐。
  const timeChars = Math.max(4, ...chapters.map((chapter) => formatTimestamp(chapter.startSec).length));
  return (
    <section class="chapters" aria-labelledby={heading ? `${id}-heading` : undefined} aria-label={heading ? undefined : t.chapters.label}>
      {heading ? (
        <div class="chapters-head">
          <h2 class="section-title" id={`${id}-heading`}>
            {chapterHeading(chapters.length, keyCount, uiLang.value)}
          </h2>
          {knownLength(totalSec) ? <span class="chapters-total">{totalLengthText(formatTimestamp(totalSec), uiLang.value)}</span> : null}
        </div>
      ) : null}
      <ol class="chapter-list" style={`--time-ch:${timeChars}`} onMouseLeave={onHover ? () => onHover(null) : undefined}>
        {chapters.map((chapter, index) => {
          const open = expanded.includes(index);
          const detailId = `${id}-detail-${index}`;
          const time = formatTimestamp(chapter.startSec);
          const key = keys[index] === true;
          const name = (
            <>
              <span class="chapter-label">
                {key ? <span class="sr-only">{`${t.chapters.key} `}</span> : null}
                <span class="chapter-name">{chapter.title}</span>
                {key ? (
                  <span class="key-tag" aria-hidden="true">
                    {t.chapters.key}
                  </span>
                ) : null}
              </span>
              <span class="chapter-span" aria-hidden="true" style={`--share:${(shares[index] ?? 0).toFixed(4)}`} />
            </>
          );
          return (
            <li
              key={index}
              class="chapter"
              data-index={index}
              data-key={key ? "true" : undefined}
              data-focus={focusIndex === index ? "true" : undefined}
              onMouseEnter={onHover ? () => onHover(index) : undefined}
            >
              <div class="chapter-row">
                <span class="key-play" aria-hidden="true">
                  {key ? <Icon name="play" /> : null}
                </span>
                <button type="button" class="chapter-time" aria-label={t.jumpTo(time)} onClick={onSeek ? () => onSeek(chapter.startSec) : undefined}>
                  {time}
                </button>
                {renderDetail ? (
                  <button type="button" class="chapter-toggle" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={onToggle ? () => onToggle(index) : undefined}>
                    {name}
                  </button>
                ) : (
                  <span class="chapter-title">{name}</span>
                )}
              </div>
              {renderDetail ? (
                <Collapse open={open}>
                  {() => (
                    <div class="chapter-detail" id={detailId}>
                      {renderDetail(chapter, index)}
                    </div>
                  )}
                </Collapse>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
