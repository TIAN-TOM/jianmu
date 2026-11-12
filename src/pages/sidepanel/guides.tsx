// 视频网站自己给的导读：官方总结（摘要和提纲）和 UP 主分段。不用设置 AI 服务就能看，取不到字幕时也照样摆出来。
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { ChapterView, OfficialSummaryView } from "../../shared/messages/transcript.ts";
import { ChapterList } from "../shared/ui/chapter-list.tsx";

const OFFICIAL_STATUS_TEXT: Readonly<Partial<Record<OfficialSummaryView["status"], string>>> = {
  queued: "视频网站正在生成官方总结，过一会儿再来看。",
  "need-login": "登录视频网站以后才看得到官方总结。",
  failed: "这次没问到官方总结，过一会儿会再问。",
  pending: "正在问官方总结…",
};

function Stamp({ at, onSeek }: { readonly at: number | null; readonly onSeek: (atSec: number) => void }) {
  if (at === null) return null;
  const time = formatTimestamp(at);
  return (
    <button type="button" class="stamp" aria-label={`跳到 ${time}`} onClick={() => onSeek(at)}>
      {time}
    </button>
  );
}

export function OfficialSummary({ official, onSeek }: { readonly official: OfficialSummaryView | undefined; readonly onSeek: (atSec: number) => void }) {
  if (!official) return null;
  if (official.status !== "ok") {
    const text = OFFICIAL_STATUS_TEXT[official.status];
    return text ? <p class="guide-status">{text}</p> : null;
  }
  return (
    <section class="guide" aria-labelledby="official-title">
      <h3 class="section-title" id="official-title">
        视频网站的官方总结
      </h3>
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
      <h3 class="section-title" id="creator-title">
        UP 主分段
      </h3>
      <ChapterList chapters={chapters.map((chapter) => ({ startSec: chapter.start, title: chapter.title }))} onSeek={onSeek} heading={false} />
    </section>
  );
}
