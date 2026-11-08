// 一组控件里用方向键移动：模式切换（单选组）和菜单共用。到头以后绕回另一头。

export type RovingAxis = "horizontal" | "vertical" | "both";

const STEP: Readonly<Record<string, { readonly axis: Exclude<RovingAxis, "both">; readonly delta: 1 | -1 }>> = {
  ArrowRight: { axis: "horizontal", delta: 1 },
  ArrowLeft: { axis: "horizontal", delta: -1 },
  ArrowDown: { axis: "vertical", delta: 1 },
  ArrowUp: { axis: "vertical", delta: -1 },
};

/** 按下 key 以后该停在第几个；这个键不归这组控件管时回 null，事件留给页面。 */
export function rovingTarget(key: string, current: number, count: number, axis: RovingAxis): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = STEP[key];
  if (!step || (axis !== "both" && step.axis !== axis)) return null;
  const from = Number.isInteger(current) && current >= 0 && current < count ? current : step.delta > 0 ? -1 : count;
  return (from + step.delta + count) % count;
}
