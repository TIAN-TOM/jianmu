// 页面上没有文字稿时的后备：经内容脚本要播放器自己取回的字幕，按不可信输入核对归属、形状和时长，认出它是播放器上的哪条轨。
// 不发请求；机器翻译的也用，交回译成的语言。只从 service.ts 的构建开关分支引用，开关关着时整个模块不进包。
import type { SiteFailure, SiteResult } from "../types.ts";
import { parseCaptionJson, type CaptionLine } from "./caption-json.ts";
import { captionReplyOf, type CaptionRequest, type PlayerCaption } from "./page/caption-types.ts";
import { END_SLACK_SEC, PANEL_LIMITS, type PlayerTrack, type PlayerTracks } from "./page/panel-types.ts";

const AUTO_KIND = "asr";

/** 读到的播放器字幕：一句一句的正文；认出的轨（认不出是 null）；机器翻译时是译成的语言，不是时是空串。 */
export interface PlayerRead {
  readonly lines: readonly CaptionLine[];
  readonly track: PlayerTrack | null;
  readonly translatedTo: string;
}

export type PageAsked = { readonly ok: true; readonly answer: unknown } | { readonly ok: false; readonly failure: SiteFailure };

export interface PlayerFallbackInput {
  readonly videoId: string;
  /** 页面上视频的时长，读不到是 0。 */
  readonly durationSec: number;
  readonly ask: (message: CaptionRequest) => Promise<PageAsked>;
}

export type PlayerFallback = (input: PlayerFallbackInput) => Promise<SiteResult<PlayerRead>>;

const fail = (code: Exclude<SiteFailure["code"], "MALFORMED">, detail?: string): SiteFailure => (detail ? { ok: false, code, detail } : { ok: false, code });
const malformed = (detail: string): SiteFailure => ({ ok: false, code: "MALFORMED", reach: "item", detail });

/** 播放器的轨里按语言和是不是自动生成只对上一条时就是它；机器翻译的、视频对不上的、对上几条的都认不出。 */
export function trackOfCaption(player: PlayerTracks | null, caption: PlayerCaption): PlayerTrack | null {
  if (!player || player.videoId !== caption.videoId || caption.translated) return null;
  const matched = player.tracks.filter((track) => track.lang === caption.lang && (track.kind === AUTO_KIND) === caption.auto);
  return matched.length === 1 && matched[0] ? matched[0] : null;
}

export const readCaughtCaptions: PlayerFallback = async ({ videoId, durationSec, ask }) => {
  const asked = await ask({ type: "youtube.caughtCaptions", req: { videoId } });
  if (!asked.ok) return asked.failure;
  const reply = captionReplyOf(asked.answer);
  if (!reply) return malformed("player-reply");
  switch (reply.outcome) {
    case "video-changed":
      return fail("VIDEO_CHANGED");
    case "ad":
      return fail("PAGE_ACTION_NEEDED", "ad");
    case "on-missed":
      return fail("UNAVAILABLE", "player-missed");
    case "no-button":
    case "not-caught":
      return fail("UNAVAILABLE", "player-none");
    case "caught":
      break;
  }
  const { caption } = reply;
  if (!caption) return malformed("player-reply");
  // 接住的不是要读的这个视频：一律不用。
  if (caption.videoId !== videoId) return fail("VIDEO_CHANGED");
  const lines = parseCaptionJson(caption.text, PANEL_LIMITS);
  if (!lines) return malformed("player-captions");
  const last = lines.at(-1);
  // 最后一句比视频时长晚太多：不是这个视频的。
  if (durationSec > 0 && last && last.start > durationSec + END_SLACK_SEC) return malformed("player-duration");
  return { ok: true, value: { lines, track: trackOfCaption(reply.player, caption), translatedTo: caption.translated ? caption.targetLang : "" } };
};
