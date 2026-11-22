// 简体专用字和繁体专用字，取自 OpenCC 的转换表（开发依赖 opencc-js，只给测试和脚本用）。
// 简体专用：简转繁表里有这个字，而且转出来的繁体一侧（单字和词组）从来没有它自己。「台、里、后、干、只、面、准、制」这类简繁通用的字，
// 总有词组转过去还是它自己（皇后、公里、干戈），不算。opencc-js 的单字表只留第一个候选，所以要连词组一起看。繁体专用反过来，用繁转简表。
import { from, to } from "opencc-js/preset";

type DictGroups = readonly (readonly (string | readonly (readonly [string, string])[])[])[];

function entriesOf(groups: DictGroups | undefined): (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [];
  for (const group of groups ?? []) {
    for (const dict of group) {
      if (typeof dict !== "string") {
        entries.push(...dict);
        continue;
      }
      for (const line of dict.split("|")) {
        const space = line.indexOf(" ");
        if (space > 0) entries.push([line.slice(0, space), line.slice(space + 1)]);
      }
    }
  }
  return entries;
}

// 表里作为单字出现、转出来的一侧从来没有它自己的字。
function onlyOnSourceSide(groups: DictGroups | undefined): ReadonlySet<string> {
  const entries = entriesOf(groups);
  const targetSide = new Set<string>();
  for (const [, values] of entries) for (const char of values) targetSide.add(char);
  return new Set(entries.filter(([key]) => [...key].length === 1 && !targetSide.has(key)).map(([key]) => key));
}

/** 只在简体里用的字。 */
export const SIMPLIFIED_ONLY: ReadonlySet<string> = onlyOnSourceSide(from.cn);

/** 只在繁体里用的字。 */
export const TRADITIONAL_ONLY: ReadonlySet<string> = onlyOnSourceSide(to.cn);

/** 文字里出现的、属于给定字表的字，按出现先后去重。 */
export function charsIn(text: string, table: ReadonlySet<string>): string[] {
  return [...new Set([...text].filter((char) => table.has(char)))];
}
