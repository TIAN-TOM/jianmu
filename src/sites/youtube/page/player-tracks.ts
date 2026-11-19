// 问页面主世界的小桥要播放器上已有的字幕轨列表。页面事件同步派发，问完当场就有回答；没有小桥、回答不对都是 null。
// 网页也看得见这些事件、也能冒充回答：只认带着这次随机标记、形状和大小都对得上的第一份，视频编号留给后台核对。
import { INJECTED } from "../../../shared/names.ts";
import { playerTracksOf, type PlayerTracks } from "./panel-types.ts";

// 回答的字数上限：两百条轨、每条的几个字段都到上限也装得下。
const ANSWER_LIMIT = 200_000;

export function askPlayerTracks(
  document: Pick<Document, "addEventListener" | "removeEventListener" | "dispatchEvent">,
  token: string = crypto.randomUUID(),
): PlayerTracks | null {
  let found: PlayerTracks | null = null;
  const onAnswer = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (found || typeof detail !== "string" || detail.length > ANSWER_LIMIT) return;
    let answer: unknown;
    try {
      answer = JSON.parse(detail);
    } catch {
      return;
    }
    if (typeof answer !== "object" || answer === null || (answer as { token?: unknown }).token !== token) return;
    found = playerTracksOf((answer as { tracks?: unknown }).tracks);
  };
  document.addEventListener(INJECTED.tracksAnswer, onAnswer);
  try {
    document.dispatchEvent(new CustomEvent(INJECTED.tracksAsk, { detail: token }));
  } catch {
    // 派发不出去就当没有小桥。
  } finally {
    document.removeEventListener(INJECTED.tracksAnswer, onAnswer);
  }
  return found;
}
