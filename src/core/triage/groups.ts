// 结论落在哪一组：四档判断，外加「还没判断」。
import type { TriageItem } from "./state.ts";

export type GroupKey = "watch" | "overview" | "skip" | "unknown" | "pending";

export interface TriageGroup {
  readonly key: GroupKey;
  readonly label: string;
}

export interface TriageVerdict {
  readonly summary?: string;
  readonly value?: string;
  readonly verdict?: string;
  readonly reason?: string;
  readonly source?: string;
}

export type VerdictMap = Readonly<Record<string, TriageVerdict | undefined>>;

// 四档判断和结论校验用的档位表同序（测试会对照）。
export const GROUPS: readonly TriageGroup[] = Object.freeze([
  Object.freeze({ key: "watch", label: "值得看完整视频" }),
  Object.freeze({ key: "overview", label: "看概览就够" }),
  Object.freeze({ key: "skip", label: "可以跳过" }),
  Object.freeze({ key: "unknown", label: "信息不足" }),
  Object.freeze({ key: "pending", label: "还没判断" }),
]);

export function hasVerdict(verdict: TriageVerdict | null | undefined): verdict is TriageVerdict {
  return Boolean(String(verdict?.summary || "").trim());
}

/**
 * 结论落在哪一组。没有结论（或只有空摘要）是「还没判断」。
 * 模型写了结论、判断却不在四档里时，校验会把档位清空：这种归到「信息不足」，
 * 它本来就是「判断不了」的那一档，比留在「还没判断」里永远等着更诚实。
 */
export function groupKeyOf(verdict: TriageVerdict | null | undefined): GroupKey {
  if (!hasVerdict(verdict)) return "pending";
  const label = String(verdict.verdict || "").trim();
  const group = GROUPS.find((entry) => entry.key !== "pending" && entry.label === label);
  return group ? group.key : "unknown";
}

export function groupItems(
  items: readonly TriageItem[],
  verdicts: VerdictMap = {},
): Record<GroupKey, TriageItem[]> {
  const groups = Object.fromEntries(GROUPS.map((group) => [group.key, [] as TriageItem[]])) as Record<
    GroupKey,
    TriageItem[]
  >;
  const list: readonly TriageItem[] = Array.isArray(items) ? items : [];
  for (const item of list) {
    groups[groupKeyOf(verdicts[item.videoKey])].push(item);
  }
  return groups;
}
