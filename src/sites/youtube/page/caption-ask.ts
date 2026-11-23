// 问页面主世界的小桥要它接住的这个视频的字幕。页面事件同步派发，问完当场就有回答；没有小桥、没接住、回答不对都是 null。
// 网页也看得见这些事件、也能冒充回答：只认带着这次随机标记、大小和形状都对、视频编号就是问的这个的第一份。
// 只从读播放器字幕的分支引用，顶层只放字面量和函数：构建开关关着时整个模块不进包。
import { INJECTED } from "../../../shared/names.ts";
import { CAPTION_LIMITS, playerCaptionOf, type PlayerCaption } from "./caption-types.ts";

/** 叫小桥开始接字幕，或者停下并把接住的清掉：内容脚本接上、撤下时各叫一次。 */
export function switchCaptionCatch(document: Pick<Document, "dispatchEvent">, on: boolean): void {
  try {
    document.dispatchEvent(new CustomEvent(INJECTED.captionsSwitch, { detail: on ? "on" : "off" }));
  } catch {
    // 派发不出去就当没有小桥。
  }
}

export function askPlayerCaption(
  document: Pick<Document, "addEventListener" | "removeEventListener" | "dispatchEvent">,
  videoId: string,
  token: string = crypto.randomUUID(),
): PlayerCaption | null {
  let found: PlayerCaption | null = null;
  const onAnswer = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (found || typeof detail !== "string" || detail.length > CAPTION_LIMITS.answer) return;
    let answer: unknown;
    try {
      answer = JSON.parse(detail);
    } catch {
      return;
    }
    if (typeof answer !== "object" || answer === null || (answer as { token?: unknown }).token !== token) return;
    const caption = playerCaptionOf((answer as { caption?: unknown }).caption);
    if (caption?.videoId === videoId) found = caption;
  };
  document.addEventListener(INJECTED.captionsAnswer, onAnswer);
  try {
    document.dispatchEvent(new CustomEvent(INJECTED.captionsAsk, { detail: JSON.stringify({ token, videoId }) }));
  } catch {
    // 派发不出去就当没有小桥。
  } finally {
    document.removeEventListener(INJECTED.captionsAnswer, onAnswer);
  }
  return found;
}
