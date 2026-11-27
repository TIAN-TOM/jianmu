// 结论块：星级和短词、菜单、结论句和依据行。侧边栏、卡片和粗筛共用。
import type { ComponentChildren } from "preact";
import { Badge } from "./button.tsx";
import { verdictLabelOf, verdictName, type VerdictRating } from "../../../core/ai/verdict.ts";
import { VerdictStars } from "./icon.tsx";
import { sharedText } from "../text.ts";
import { uiLang } from "../ui-lang.ts";
import { bandOf, basisText, type BasisSource } from "./verdict.ts";

export interface VerdictBlockProps {
  /** 结论可能来自旧记录，展示时再认出它的星数。 */
  readonly label: unknown;
  readonly text: string;
  /** 卡片已在标题栏显示判断，正文先写理由再写摘要。旧记录缺理由时传空串。 */
  readonly cardReason?: string;
  readonly basis?: BasisSource | null;
  /** 换过字幕：这份结论基于旧字幕。 */
  readonly staleTranscript?: boolean;
  /** 概览有失败的块，结论只基于部分内容。 */
  readonly incomplete?: boolean;
  /** 右上角的菜单，由页面放进来。 */
  readonly menu?: ComponentChildren;
  /** 这一屏上看着它写出来的（先是「正在写结论」）：进来时有「有结果了」那一下。打开页面时已经有的不算。 */
  readonly fresh?: boolean;
}

/** 不在结论块里的结果（章节、问答）基于旧字幕时，单独标一行。 */
export function StaleTranscriptLine() {
  return (
    <p class="verdict-basis">
      <Badge tone="line">{sharedText().verdict.stale}</Badge>
    </p>
  );
}

/** 星级和短词只有一个读屏名称；信息不足直接读出短词。 */
export function VerdictLabel({ rating, class: className = "verdict-label" }: { readonly rating: VerdictRating; readonly class?: string }) {
  const name = verdictName(rating, uiLang.value);
  if (typeof rating !== "number") return <span class={className}><span class="verdict-name">{name}</span></span>;
  return (
    <span class={className} role="img" aria-label={sharedText().verdict.stars(rating, name)}>
      <VerdictStars stars={rating} />
      <span class="verdict-name" aria-hidden="true">{name}</span>
    </span>
  );
}

export function VerdictBlock({ label, text, cardReason, basis, staleTranscript = false, incomplete = false, menu, fresh = false }: VerdictBlockProps) {
  const t = sharedText().verdict;
  const lang = uiLang.value;
  const rating = verdictLabelOf(label);
  return (
    <section class="verdict" aria-label={t.label} data-band={bandOf(rating)} data-fresh={fresh ? "true" : undefined}>
      {cardReason === undefined ? (
        <div class="verdict-head">
          {rating ? <VerdictLabel rating={rating} /> : <span class="verdict-label" />}
          {menu ? <span class="verdict-menu">{menu}</span> : null}
        </div>
      ) : cardReason ? <p class="card-reason">{cardReason}</p> : null}
      <p class={cardReason === undefined ? "verdict-text" : "card-summary"}>{text}</p>
      {basis || staleTranscript || incomplete ? (
        <p class="verdict-basis">
          {basis ? <span>{basisText(basis, lang)}</span> : null}
          {incomplete ? <Badge tone="warn">{t.incomplete}</Badge> : null}
          {staleTranscript ? <Badge tone="line">{t.stale}</Badge> : null}
        </p>
      ) : null}
    </section>
  );
}
