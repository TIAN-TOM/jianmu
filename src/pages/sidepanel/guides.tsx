// 视频网站自己给的导读：官方总结（摘要和提纲）和 UP 主分段。不用设置 AI 服务就能看，取不到字幕时也照样摆出来。
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { ChapterView, OfficialSummaryView } from "../../shared/messages/transcript.ts";
import { sharedText } from "../shared/text.ts";
import { ChapterList } from "../shared/ui/chapter-list.tsx";
import { panelText, type PanelText } from "./text.ts";

const statusText = (status: OfficialSummaryView["status"], t: PanelText["guides"]): string | undefined =>
  status === "queued" ? t.queued : status === "need-login" ? t.needLogin : status === "failed" ? t.failed : status === "pending" ? t.pending : undefined;

function Stamp({ at, onSeek }: { readonly at: number | null; readonly onSeek: (atSec: number) => void }) {
  if (at === null) return null;
  const time = formatTimestamp(at);
  return (
    <button type="button" class="stamp" aria-label={sharedText().jumpTo(time)} onClick={() => onSeek(at)}>
      {time}
    </button>
  );
}

export function OfficialSummary({ official, onSeek }: { readonly official: OfficialSummaryView | undefined; readonly onSeek: (atSec: number) => void }) {
  if (!official) return null;
  const t = panelText().guides;
  if (official.status !== "ok") {
    const text = statusText(official.status, t);
    return text ? <p class="guide-status">{text}</p> : null;
  }
  return (
    <section class="guide" aria-labelledby="official-title">
      <h2 class="section-title" id="official-title">
        {t.official}
      </h2>
      {official.summary ? <p class="guide-summary">{official.summary}</p> : null}
      {official.outline.length > 0 ? (
        <ol class="outline">
          {official.outline.map((section, index) => (
            <li key={index} class="outline-section">
              <p class="outline-title">
                <Stamp at={section.timestamp} onSeek={onSeek} />
                <span>{section.title}</span>
              </p>
              {section.points.length > 0 ? (
                <ul class="outline-points">
                  {section.points.map((point, at) => (
                    <li key={at}>
                      <Stamp at={point.timestamp} onSeek={onSeek} />
                      <span>{point.content}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

export function CreatorChapters({ chapters, onSeek }: { readonly chapters: readonly ChapterView[] | undefined; readonly onSeek: (atSec: number) => void }) {
  if (!chapters?.length) return null;
  return (
    <section class="guide" aria-labelledby="creator-title">
      <h2 class="section-title" id="creator-title">
        {panelText().guides.creator}
      </h2>
      <ChapterList chapters={chapters.map((chapter) => ({ startSec: chapter.start, title: chapter.title }))} onSeek={onSeek} heading={false} />
    </section>
  );
}
