// 一行提示：在头部和内容区之间，不盖内容，一次只显示一条。
// 播报区一直在页面上，提示换了读屏才念得出来；念的方式是礼貌播报，不打断正在读的内容。
// 出现时这一行从零长高、下面的内容跟着往下让，消失时收回去，内容不是一下子跳开；换一条时新的那条淡进来。
import { sharedText } from "../text.ts";
import { pickNotice, type NoticeEntry } from "./notice.ts";
import { usePresence } from "./presence.ts";

export function Notice({ notices }: { readonly notices: readonly (NoticeEntry | null | undefined | false)[] }) {
  const notice = pickNotice(notices);
  const { shown, leaving, ref } = usePresence(notice);
  return (
    <div
      ref={(node) => {
        ref.current = node;
      }}
      class="notice-slot collapse"
      aria-live="polite"
      data-open={notice ? "true" : "false"}
    >
      <div class="notice-clip collapse-in">
        {shown ? (
          <div class="notice" key={shown.id} data-id={shown.id} data-tone={shown.tone} data-leaving={leaving ? "true" : undefined} inert={leaving}>
            <span class="notice-text">{shown.text}</span>
            {shown.action ? (
              <button type="button" class="notice-action" onClick={shown.action.run}>
                {shown.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 报错的三段式下面那一行：服务自己说的话，默认收着，点开才看。原话是外来文字，
 * 只作为文字节点渲染，不当链接也不当标记；后台已经清洗、截短、遮过像密钥的片段。
 */
export function ServiceSaid({ said }: { readonly said?: string | undefined }) {
  if (!said) return null;
  return (
    <details class="service-said">
      <summary>{sharedText().serviceSaid}</summary>
      <p class="service-said-text">{said}</p>
    </details>
  );
}
