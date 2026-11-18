// 设置页「打开就出结论」的分钟数：范围说明，以及填的数被规整成另一个数时就地给的一句话。
import { AUTO_OVERVIEW_MINUTES, normalizeAutoMinutes } from "../../shared/settings-schema.ts";

const { min, max } = AUTO_OVERVIEW_MINUTES;

export const AUTO_MINUTES_HINT = `${min} 到 ${max} 的整数，填 0 时每个视频都生成。`;

export interface SettledMinutes {
  readonly minutes: number;
  /** 存下的数和填的不一样时说改成了多少、为什么；照存时是 null。 */
  readonly note: string | null;
}

/** 输入框里的文字规整成要存的分钟数；清空或填不成数时回 null，由页面填回原来的数。 */
export function settleAutoMinutes(raw: string): SettledMinutes | null {
  const text = raw.trim();
  const typed = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(typed)) return null;
  const minutes = normalizeAutoMinutes(typed);
  if (typed > max) return { minutes, note: `最多 ${max} 分钟，已改成 ${minutes}。` };
  if (typed < min) return { minutes, note: `最少 ${min} 分钟，已改成 ${minutes}。` };
  if (minutes !== typed) return { minutes, note: `只能填整数，已改成 ${minutes}。` };
  return { minutes, note: null };
}
