// 结论块的显示规则：判断档位配什么标记、依据行怎么写。
// 形状带信息，颜色只是第二层，色弱和黑白截图下也分得清。档位名照数据写，这里只认现有的几档。
import { verdictLabelOf, verdictName } from "../../../core/ai/verdict.ts";
import { onOldTranscript, type Basis, type OverviewTranscriptBasis } from "../../../core/notes/records.ts";
import { sharedTextOf } from "../text.ts";
import type { UiLang } from "../ui-lang.ts";

export type MarkShape = "go" | "fair" | "skip" | "unknown" | "square";

/** 全部标记形状。 */
export const MARK_SHAPES: readonly MarkShape[] = Object.freeze(["go", "fair", "skip", "unknown", "square"]);

// 四档各一种形状，具体怎么画由主题挑（三套画法见 icons.ts 的 MARK_SETS）。旧版的「看概览就够」单独一种，形状上不混进四档。
const MARKS: Readonly<Record<string, MarkShape>> = Object.freeze({
  推荐看: "go",
  可以看: "fair",
  可跳过: "skip",
  信息不足: "unknown",
  看概览就够: "square",
});

/** 档位配的标记，旧版改了名的按新名字配；认不出的档位（模型自创的、空的）不画标记。 */
export function markOf(label: string | null | undefined): MarkShape | null {
  return MARKS[verdictLabelOf(label)] ?? null;
}

/** 档位显示的名字：旧版改了名的显示新名字，「看概览就够」照旧，按语言换成显示名；认不出的档位是空串。 */
export function labelOf(label: string | null | undefined, lang: UiLang = "zh"): string {
  const known = verdictLabelOf(label);
  return known ? verdictName(known, lang) : "";
}

export type BasisSource = Basis["source"];

/** 依据行：结论按实际依据标注。 */
export function basisText(source: BasisSource, lang: UiLang = "zh"): string {
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
