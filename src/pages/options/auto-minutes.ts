// 设置页「打开就出结论」的分钟数：范围说明，以及填的数被规整成另一个数时就地给的一句话。语言缺省中文。
import { AUTO_OVERVIEW_MINUTES, normalizeAutoMinutes } from "../../shared/settings-schema.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { textOf } from "./text.ts";

const { min, max } = AUTO_OVERVIEW_MINUTES;

/** 输入框下面的范围说明。 */
export const autoMinutesHint = (lang: UiLang = "zh"): string => textOf(lang).auto.minutesHint(min, max);

export interface SettledMinutes {
  readonly minutes: number;
  /** 存下的数和填的不一样时说改成了多少、为什么；照存时是 null。 */
  readonly note: string | null;
}

/** 输入框里的文字规整成要存的分钟数；清空或填不成数时回 null，由页面填回原来的数。 */
export function settleAutoMinutes(raw: string, lang: UiLang = "zh"): SettledMinutes | null {
  const text = raw.trim();
  const typed = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(typed)) return null;
  const minutes = normalizeAutoMinutes(typed);
  const t = textOf(lang).auto;
  if (typed > max) return { minutes, note: t.aboveMax(max, minutes) };
  if (typed < min) return { minutes, note: t.belowMin(min, minutes) };
  if (minutes !== typed) return { minutes, note: t.notWhole(minutes) };
  return { minutes, note: null };
}
