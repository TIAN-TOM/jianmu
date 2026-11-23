// 侧边栏里的复制：写进剪贴板，在顶上一行说结果；要复制的文字怎么拼也在这里。
import { splitAnswerByTimestamps } from "../../core/qa/citations.ts";
import type { Panel } from "./panel.ts";
import { panelText } from "./text.ts";

/** 把文字写进剪贴板，成功时说 done（缺省「已复制」），被拒时说没能复制。 */
export function copyText(panel: Pick<Panel, "say">, text: string, done?: string): Promise<void> {
  return navigator.clipboard.writeText(text).then(
    () => panel.say(done ?? panelText().copied),
    () => panel.say(panelText().copyFailed),
  );
}

/** 回答的文字：界面上去掉了方括号的时间点按 [分:秒] 写回去，区间照样是「起-止」。 */
export const answerCopyText = (answer: string): string =>
  splitAnswerByTimestamps(answer)
    .map((part) => (part.seconds === undefined ? part.text : `[${part.text}]`))
    .join("")
    .trim();
