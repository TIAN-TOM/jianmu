// 卡片上的章节列表（PRD 第 6.5 节）：章节多时整份都在，列表固定露出前几章那么高、下一章露出大半并淡出，其余在列表里滚动，
// 底下写共几章；章节少时全露。看后面的章节时卡片不变高，播放页右栏不重排。滚到底以后滚轮接着往外滚，不拦着：右栏是常用滚轮翻推荐的地方。
// 高度按前几章实际排出来的高度量，标题换行、字号、卡片宽窄变了重新量。
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { ChapterList, type ChapterItem } from "../shared/ui/chapter-list.tsx";
import { CARD_ROWS, cardRows } from "./rows.ts";
import { cardText } from "./text.ts";

/** 下一章露出它自己多高的几成：淡出的下沿落在它身上，看得出下面还有。 */
const PEEK = 0.7;

export function CardChapters({ chapters, keyStarts, onSeek }: { readonly chapters: readonly ChapterItem[]; readonly keyStarts: readonly number[]; readonly onSeek: (atSec: number) => void }) {
  const scrolls = cardRows(chapters, false).length < chapters.length;
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [atEnd, setAtEnd] = useState(false);
  useLayoutEffect(() => {
    const node = box.current;
    if (!scrolls || !node) return;
    const measure = (): void => {
      const next = node.querySelectorAll<HTMLElement>(".chapter")[CARD_ROWS];
      if (!next) return;
      const top = next.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
      setHeight(Math.round(top + next.offsetHeight * PEEK));
    };
    measure();
    const content = node.firstElementChild;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scrolls, chapters.length]);
  const list = <ChapterList chapters={chapters} keyStarts={keyStarts} heading={false} onSeek={onSeek} />;
  if (!scrolls) return list;
  return (
    <div>
      <div
        class="card-chapter-scroll"
        id="card-chapters"
        ref={box}
        data-end={atEnd ? "" : undefined}
        style={height === null ? undefined : { maxHeight: `${height}px` }}
        onScroll={(event) => {
          const node = event.currentTarget;
          setAtEnd(node.scrollTop + node.clientHeight >= node.scrollHeight - 1);
        }}
      >
        {list}
      </div>
      <p class="card-chapter-count">{cardText().chapterCount(chapters.length)}</p>
    </div>
  );
}
