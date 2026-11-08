// 模式规则：打开视频时进哪个模式，长视频在速览里播满 1 分钟切到精读。纯函数，规则照 PRD 第 6 节。
// 观看会话每次有变化都调它，侧边栏和卡片只读结果，自己不算模式。
import type { Mode, ModeSource } from "./types.ts";

/** 不到这么长算短视频，打开就进精读。 */
export const SHORT_VIDEO_SEC = 5 * 60;

/** 长视频在速览里累计播放满这么久，切到精读。 */
export const AUTO_SWITCH_SEC = 60;

export interface ModeState {
  readonly mode: Mode;
  readonly source: ModeSource;
}

export interface ModeInput {
  /** 视频时长。不知道时按长视频算：不主动进精读，也照常自动切。 */
  readonly durationSec?: number;
  /** 用户给这个频道选过的模式。 */
  readonly channelMode?: Mode;
  /** 这次观看里手动选的模式。 */
  readonly manualMode?: Mode;
  /** 这次观看累计播放的秒数。 */
  readonly playedSec: number;
  /** 现在的模式和来源，还没定过时不给。 */
  readonly current?: ModeState;
  /** 这次观看已经自动切过，撤销了也算：每次观看最多切一次。 */
  readonly autoSwitched: boolean;
}

const MODES: ReadonlySet<string> = new Set<Mode>(["skim", "study"]);

/** 从消息或存储里读出来的模式先过它。 */
export const isMode = (value: unknown): value is Mode => typeof value === "string" && MODES.has(value);

export const isShortVideo = (durationSec: number | undefined): boolean =>
  durationSec !== undefined && durationSec < SHORT_VIDEO_SEC;

/** 打开时进哪个模式：频道偏好在先，没有时按时长。 */
export function openingMode({ durationSec, channelMode }: Pick<ModeInput, "durationSec" | "channelMode">): ModeState {
  if (channelMode) return { mode: channelMode, source: "channel" };
  return isShortVideo(durationSec) ? { mode: "study", source: "short" } : { mode: "skim", source: "default" };
}

export function decideMode(input: ModeInput): ModeState {
  if (input.manualMode) return { mode: input.manualMode, source: "manual" };
  // 切过以后不再切：还停在自动切的结果上就保持，撤销过的回到打开时的模式。
  if (input.autoSwitched) return input.current?.source === "auto" ? { mode: "study", source: "auto" } : openingMode(input);
  const opening = openingMode(input);
  // 频道偏好只定打开时的模式，不挡自动切换；短视频不切。
  if (opening.mode === "skim" && !isShortVideo(input.durationSec) && input.playedSec >= AUTO_SWITCH_SEC) {
    return { mode: "study", source: "auto" };
  }
  return opening;
}
