// 稍后再看按星数分组；还没写结论和材料不足各留一组。
import { VERDICT_STARS, verdictLabelOf, verdictText, type VerdictStars } from "../ai/verdict.ts";
import { inLang, type OutputLang } from "../output-lang.ts";
import { PENDING_HANT } from "./groups-hant.ts";
import type { TriageItem } from "./state.ts";

export type GroupKey = VerdictStars | "pending" | "unknown";

export const GROUPS: readonly GroupKey[] = Object.freeze([...VERDICT_STARS, "pending", "unknown"]);

export interface TriageVerdict {
  readonly summary?: string;
  readonly value?: string;
  readonly verdict?: number | string;
  readonly reason?: string;
  readonly source?: string;
}

export type VerdictMap = Readonly<Record<string, TriageVerdict | undefined>>;

/** Markdown 分组标题；没有星数的两组只写状态。 */
export function groupName(key: GroupKey, lang: OutputLang = "zh"): string {
  if (key === "pending") return inLang(lang, "还没判断", "Not judged yet", PENDING_HANT);
  return verdictText(key === "unknown" ? "信息不足" : key, lang);
}

export function hasVerdict(verdict: TriageVerdict | null | undefined): verdict is TriageVerdict {
  return Boolean(String(verdict?.summary || "").trim());
}

/** 旧判断按星数归组。已经有结论但评分缺失的，仍归到「信息不足」。 */
export function groupKeyOf(verdict: TriageVerdict | null | undefined): GroupKey {
  if (!hasVerdict(verdict)) return "pending";
  const rating = verdictLabelOf(verdict.verdict);
  return typeof rating === "number" ? rating : "unknown";
}

export function groupItems(
  items: readonly TriageItem[],
  verdicts: VerdictMap = {},
): Record<GroupKey, TriageItem[]> {
  const groups = Object.fromEntries(GROUPS.map((key) => [key, [] as TriageItem[]])) as Record<
    GroupKey,
    TriageItem[]
  >;
  const list: readonly TriageItem[] = Array.isArray(items) ? items : [];
  for (const item of list) {
    groups[groupKeyOf(verdicts[item.videoKey])].push(item);
  }
  return groups;
}
