// 结论的显示规则：按星级选色带，标出判断依据和使用旧字幕的部分。
import type { VerdictRating } from "../../../core/ai/verdict.ts";
import { onOldTranscript, type Basis, type OverviewTranscriptBasis } from "../../../core/notes/records.ts";
import { sharedTextOf } from "../text.ts";
import type { UiLang } from "../ui-lang.ts";

/** 「看不看」主题里，星数相近的判断用同一条色带。 */
export function bandOf(rating: VerdictRating | ""): "go" | "fair" | "skip" | "unknown" | undefined {
  if (rating === "") return undefined;
  if (rating === "信息不足") return "unknown";
  return rating >= 4 ? "go" : rating === 3 ? "fair" : "skip";
}

export type BasisSource = Basis["source"];

/** 依据行：结论按实际依据标注。 */
export function basisText(source: BasisSource, lang: UiLang): string {
  return sharedTextOf(lang).verdict.basis[source];
}

/**
 * 概览哪几处标「基于旧字幕」：结论块标结论自己的；章节基于旧字幕、结论块里又没标出来时，章节上面单独标一行。
 * current 是现在用的字幕的指纹，不知道时哪处都不标。
 */
export function staleOverviewMarks(
  basis: OverviewTranscriptBasis | undefined,
  current: string | null | undefined,
  verdictShown: boolean,
): { readonly verdict: boolean; readonly chapters: boolean } {
  const verdict = verdictShown && onOldTranscript(basis?.verdict, current);
  return { verdict, chapters: !verdict && onOldTranscript(basis?.chapters, current) };
}
