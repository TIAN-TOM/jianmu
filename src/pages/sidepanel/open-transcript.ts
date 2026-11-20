// 用户点「读取字幕」读 YouTube 视频时，先让视频页替他点开文字稿面板，再照常读。只从构建开关
// FEATURE_YOUTUBE_OPEN_PANEL 的分支引用，开关关着时整个模块不进包。点开没成功不拦着：读取照常走，按页面上的实际样子报。
import type { VideoKey } from "../../core/video-ref.ts";
import type { TranscriptFailure } from "../../shared/messages/transcript.ts";
import type { PageApi } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";

/** 还没读过字幕时的说明：点读取，简幕替你点开文字稿。 */
export const openReadHint = (lang: UiLang = "zh"): string =>
  lang === "en"
    ? "Click Read subtitles and Jianmu will open the transcript on the video page for you and read what it shows."
    : "点读取，简幕会替你点开视频页上的文字稿，读里面显示的内容。";

/** 回 null 是接着读；回失败就停在这里，不读。 */
export async function openTranscriptFirst(api: Pick<PageApi, "send">, video: VideoKey, tabId: number): Promise<TranscriptFailure | null> {
  const reply = await api.send("youtube.openTranscript", { video, tabId });
  if (!reply.ok) return null;
  if (reply.value.outcome === "ad") return { ok: false, code: "PAGE_ACTION_NEEDED", detail: "ad" };
  if (reply.value.outcome === "video-changed") return { ok: false, code: "VIDEO_CHANGED" };
  return null;
}
