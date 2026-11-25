// YouTube 页面主世界的只读小桥：内容脚本问一句，交回播放器上已有的字幕轨列表（语言、类别、显示名、编号）、默认轨、视频编号，以及播放器拿到的数据说不说这个视频能正常播。
// 只读不改：不调会改播放器的方法，不交字幕地址，不发请求，没有扩展接口。新注入的一份先叫旧的停下。
// 问答走带随机标记的页面事件；网页也看得见这些事件，内容脚本那头按不可信输入核对。
import { INJECTED } from "../../../shared/names.ts";
import { PANEL_LIMITS, type PlayerTrack, type PlayerTracks } from "./panel-types.ts";

const PLAYER = "movie_player";
const AUTO_KIND = "asr";
const PLAYABLE = "OK";
const TOKEN = /^[\w-]{8,64}$/;

type Fields = Readonly<Record<string, unknown>>;
const fields = (value: unknown): Fields | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null);
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.slice(0, max) : "");

function nameOf(value: unknown): string {
  const name = fields(value);
  if (!name) return "";
  if (typeof name.simpleText === "string") return name.simpleText;
  const runs = Array.isArray(name.runs) ? name.runs : [];
  return runs.map((run) => text(fields(run)?.text, PANEL_LIMITS.trackName)).join("");
}

function trackOf(value: unknown): PlayerTrack {
  const track = fields(value);
  const kind = text(track?.kind, PANEL_LIMITS.trackKind);
  return {
    lang: text(track?.languageCode, PANEL_LIMITS.trackLang),
    // 只认自动生成这一种标记，别的类别照空串交回。
    kind: kind === AUTO_KIND ? kind : "",
    name: nameOf(track?.name).trim().slice(0, PANEL_LIMITS.trackName),
    vssId: text(track?.vssId, PANEL_LIMITS.trackId),
  };
}

const indexOf = (value: unknown): number | null => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null);

/** 播放器上现在的字幕轨列表；没有播放器、读不到视频编号或者轨太多时是 null。 */
export function readPlayerTracks(document: Pick<Document, "getElementById">): PlayerTracks | null {
  try {
    const player = document.getElementById(PLAYER) as (Element & { getPlayerResponse?: unknown }) | null;
    const read = player?.getPlayerResponse;
    if (typeof read !== "function") return null;
    const response = fields(read.call(player));
    const videoId = text(fields(response?.videoDetails)?.videoId, 64);
    if (!videoId) return null;
    const list = fields(fields(response?.captions)?.playerCaptionsTracklistRenderer);
    const raw: unknown[] = Array.isArray(list?.captionTracks) ? list.captionTracks : [];
    if (raw.length > PANEL_LIMITS.tracks) return null;
    const tracks = raw.map(trackOf);
    // 默认音轨里的默认字幕轨。只有一条音轨时它就是默认音轨。
    const audios: unknown[] = Array.isArray(list?.audioTracks) ? list.audioTracks : [];
    const audioIndex = indexOf(list?.defaultAudioTrackIndex) ?? (audios.length === 1 ? 0 : null);
    const audio = audioIndex === null ? null : fields(audios[audioIndex]);
    const defaultIndex = indexOf(audio?.defaultCaptionTrackIndex);
    const hasDefault = typeof audio?.hasDefaultTrack === "boolean" ? audio.hasDefaultTrack : null;
    // 播不了的视频（要登录、地区限制、还没开播这些）数据不全，列表空着不说明没有字幕。
    const playable = fields(response?.playabilityStatus)?.status === PLAYABLE;
    return { videoId, tracks, defaultIndex: defaultIndex !== null && defaultIndex < tracks.length ? defaultIndex : null, hasDefault, playable };
  } catch {
    return null;
  }
}

/** 开始回答内容脚本的问话，返回停下的函数。 */
export function startMainBridge(document: Pick<Document, "getElementById" | "addEventListener" | "removeEventListener" | "dispatchEvent">): () => void {
  document.dispatchEvent(new CustomEvent(INJECTED.bridgeRetire));
  const onAsk = (event: Event): void => {
    const token: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof token !== "string" || !TOKEN.test(token)) return;
    const answer = JSON.stringify({ token, tracks: readPlayerTracks(document) });
    document.dispatchEvent(new CustomEvent(INJECTED.tracksAnswer, { detail: answer }));
  };
  const stop = (): void => {
    document.removeEventListener(INJECTED.tracksAsk, onAsk);
    document.removeEventListener(INJECTED.bridgeRetire, stop);
  };
  document.addEventListener(INJECTED.tracksAsk, onAsk);
  document.addEventListener(INJECTED.bridgeRetire, stop);
  return stop;
}
