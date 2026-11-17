// 结论块的显示规则：判断档位配什么标记、依据行怎么写。
// 形状带信息，颜色只是第二层，色弱和黑白截图下也分得清。档位名照数据写，这里只认现有的几档。
import { verdictLabelOf } from "../../../core/ai/verdict.ts";
import type { Basis } from "../../../core/notes/records.ts";

export type MarkShape = "go" | "fair" | "skip" | "unknown" | "square";

/** 全部标记形状。 */
export const MARK_SHAPES: readonly MarkShape[] = Object.freeze(["go", "fair", "skip", "unknown", "square"]);

// 新四档是一条线上的圆：实心、半实心、空心、问号。旧版的「看概览就够」不在这条线上，用方块，形状上不混进去。
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

/** 档位显示的名字：旧版改了名的显示新名字，「看概览就够」照旧。 */
export function labelOf(label: string | null | undefined): string {
  return verdictLabelOf(label);
}

export type BasisSource = Basis["source"];

const BASIS_TEXT: Readonly<Record<BasisSource, string>> = Object.freeze({
  transcript: "依据字幕",
  "official-summary": "依据 B 站官方总结，没有通读字幕",
  "title-description": "依据标题和简介",
  "legacy-unknown": "依据未知（旧版）",
});

/** 依据行：结论按实际依据标注。 */
export function basisText(source: BasisSource): string {
  return BASIS_TEXT[source];
}
