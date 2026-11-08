// 一行提示：在头部和内容区之间，不盖内容，一次只显示一条。
// 播报区一直在页面上，提示换了读屏才念得出来；念的方式是礼貌播报，不打断正在读的内容。
import { pickNotice, type NoticeEntry } from "./notice.ts";

export function Notice({ notices }: { readonly notices: readonly (NoticeEntry | null | undefined | false)[] }) {
  const notice = pickNotice(notices);
  return (
    <div class="notice-slot" aria-live="polite">
      {notice ? (
        <div class="notice" key={notice.id} data-id={notice.id} data-tone={notice.tone}>
          <span class="notice-text">{notice.text}</span>
          {notice.action ? (
            <button type="button" class="notice-action" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
