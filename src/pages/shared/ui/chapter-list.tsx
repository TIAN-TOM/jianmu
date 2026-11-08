// 章节列表：时间是单独的按钮（跳到这一章），章节名展开要点和字幕。重点章节前面一个圆点，读屏读出「重点」。
// 展开的内容由页面给；不给就只是一行时间加章节名。
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { formatTimestamp } from "../../../core/transcript/segment.ts";
import { chapterHeading, keyFlags } from "./chapters.ts";

export interface ChapterItem {
  readonly startSec: number;
  readonly title: string;
}

export interface ChapterListProps {
  readonly chapters: readonly ChapterItem[];
  readonly keyStarts?: readonly number[] | undefined;
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

export function ChapterList({ chapters, keyStarts, expanded = [], onToggle, onSeek, focusIndex = null, onHover, renderDetail, heading = true }: ChapterListProps) {
  const id = useId();
  const keys = keyFlags(chapters, keyStarts);
  const keyCount = keys.filter(Boolean).length;
  return (
    <section class="chapters" aria-labelledby={heading ? `${id}-heading` : undefined} aria-label={heading ? undefined : "章节"}>
      {heading ? (
        <h3 class="section-title" id={`${id}-heading`}>
          {chapterHeading(chapters.length, keyCount)}
        </h3>
      ) : null}
      <ol class="chapter-list" onMouseLeave={onHover ? () => onHover(null) : undefined}>
        {chapters.map((chapter, index) => {
          const open = expanded.includes(index);
          const detailId = `${id}-detail-${index}`;
          const time = formatTimestamp(chapter.startSec);
          const name = (
            <>
              {keys[index] ? <span class="key-dot" role="img" aria-label="重点" /> : null}
              <span class="chapter-name">{chapter.title}</span>
            </>
          );
          return (
            <li
              key={index}
              class="chapter"
              data-index={index}
              data-key={keys[index] ? "true" : undefined}
              data-focus={focusIndex === index ? "true" : undefined}
              onMouseEnter={onHover ? () => onHover(index) : undefined}
            >
              <div class="chapter-row">
                <button type="button" class="chapter-time" aria-label={`跳到 ${time}`} onClick={onSeek ? () => onSeek(chapter.startSec) : undefined}>
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
              {renderDetail && open ? (
                <div class="chapter-detail" id={detailId}>
                  {renderDetail(chapter, index)}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
