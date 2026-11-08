// 结论块的显示规则：判断档位配什么标记、依据行怎么写。
// 形状带信息，颜色只是第二层，色弱和黑白截图下也分得清。档位名照数据写，这里只认现有的几档。
import { VERDICT_LABELS } from "../../../core/ai/verdict.ts";
import type { Basis } from "../../../core/notes/records.ts";

export type MarkShape = "go" | "fair" | "skip" | "unknown" | "square";

/** 全部标记形状。半实心圆留给以后加的「可以看」，现在没有档位用它。 */
export const MARK_SHAPES: readonly MarkShape[] = Object.freeze(["go", "fair", "skip", "unknown", "square"]);

// 「看概览就够」不属于推荐、跳过、信息不足这条线，用方块，形状上不混进圆形那几档。
const MARKS: Readonly<Record<string, MarkShape>> = Object.freeze({
  值得看完整视频: "go",
  看概览就够: "square",
  可以跳过: "skip",
  信息不足: "unknown",
});

/** 档位配的标记；认不出的档位（模型自创的、空的）不画标记。 */
export function markOf(label: string | null | undefined): MarkShape | null {
  const key = String(label ?? "").trim();
  return VERDICT_LABELS.includes(key) ? (MARKS[key] ?? null) : null;
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
