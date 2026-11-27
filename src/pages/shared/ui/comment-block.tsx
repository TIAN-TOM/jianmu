// 评论区那一块（PRD F23）：侧边栏摆整块，卡片摆一行、有要点时点开才露；章节标记交给章节列表。只在构建开关 FEATURE_COMMENTS 打开时进包，只从开关分支引用。
// 数据来自存着的结论，照形状再核一遍；原评论是别人写的，只当纯文本显示，默认收着，点开才露。
import { FEW_COMMENTS, type CommentView } from "../../../core/ai/comments.ts";
import { Badge } from "./button.tsx";
import { Collapse } from "./collapse.tsx";
import { commentText, tagName } from "./comment-text.ts";

export { commentNotes, commentViewOfVerdict } from "./comment-text.ts";

const TAG_TONES: Readonly<Record<string, string>> = {
  好评居多: "ok",
  有争议: "warn",
  有人指出错误: "danger",
  说是标题党: "warn",
};

/** 侧边栏评论区的口碑标签和一句话。 */
export function CommentLine({ view }: { readonly view: CommentView }) {
  const text = commentText();
  return (
    <p class="comment-line" aria-label={text.title}>
      <Badge tone="line">{tagName(view.tag, text)}</Badge>
      {view.line ? <span class="comment-line-text">{view.line}</span> : null}
    </p>
  );
}

/** 要点列表：最多四条，每条点开露出它依据的原评论。 */
function CommentPoints({ view, id, showSingleCount = true }: { readonly view: CommentView; readonly id?: string; readonly showSingleCount?: boolean }) {
  const text = commentText();
  return (
    <ul class="comment-points" id={id}>
      {view.points.map((point, index) => (
        <li key={index}>
          <details class="comment-point">
            <summary>
              <span class="comment-point-text">{point.text}</span>
              {showSingleCount || point.quotes.length > 1 ? <span class="comment-count">{text.quotes(point.quotes.length)}</span> : null}
            </summary>
            <ul class="comment-quotes">
              {point.quotes.map((quote, at) => (
                <li key={at} class="comment-quote">
                  <p class="comment-quote-text">{quote.text}</p>
                  <p class="comment-quote-meta">{[quote.pinned ? text.pinned : "", text.likes(quote.likes)].filter(Boolean).join(" · ")}</p>
                </li>
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}

/** 侧边栏的整块：口碑和一句话，下面最多四条要点，每条点开露出它依据的原评论。 */
export function CommentBlock({ view }: { readonly view: CommentView }) {
  const text = commentText();
  return (
    <section class="comment-block" aria-label={text.title}>
      <h2 class="section-title">{text.title}</h2>
      <CommentLine view={view} />
      {view.points.length ? <CommentPoints view={view} /> : null}
    </section>
  );
}

/** 卡片上的那一行：有要点时整行是个开关，点开露出要点，每条再点开露出原评论；没有要点时只是一行。 */
export function CommentFold({ view, open, onToggle }: { readonly view: CommentView; readonly open: boolean; readonly onToggle: () => void }) {
  if (view.tag === FEW_COMMENTS && !view.points.length) return null;
  const text = commentText();
  const line = (
    <span class="comment-line card-comment-line">
      {text.cardLabel} <span class="comment-tag" data-tone={TAG_TONES[view.tag]}>{tagName(view.tag, text)}</span>
      {view.line && ` ${view.line}`}
    </span>
  );
  if (!view.points.length) return <p>{line}</p>;
  return (
    <div class="comment-fold" aria-label={text.title} role="group">
      <button type="button" class="card-fold-head comment-fold-head" aria-expanded={open} aria-controls={open ? "card-comment-points" : undefined} onClick={onToggle}>
        {line}
        <span class="card-chevron" aria-hidden="true" />
      </button>
      <Collapse open={open}>{() => <CommentPoints view={view} id="card-comment-points" showSingleCount={false} />}</Collapse>
    </div>
  );
}
