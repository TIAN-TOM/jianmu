// 一行提示一次只显示一条：页面把眼下成立的几条都交进来，这里按优先级挑一条。
// 优先级的数值由各页面定，数小的先显示。

export type NoticeTone = "warn" | "plain" | "accent";

export interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

export interface NoticeEntry {
  /** 同一条提示换了文字也是同一条，渲染时按它认。 */
  readonly id: string;
  readonly priority: number;
  readonly text: string;
  readonly tone: NoticeTone;
  readonly action?: NoticeAction;
}

/** 数小的优先，同样优先的取先交进来的；不成立的写成 null、undefined 或 false 交进来就行。 */
export function pickNotice<T extends { readonly priority: number }>(candidates: readonly (T | null | undefined | false)[]): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (!candidate || !Number.isFinite(candidate.priority)) continue;
    if (best === null || candidate.priority < best.priority) best = candidate;
  }
  return best;
}
