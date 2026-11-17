// 播放计时：按实际播放累计这次观看看了多久，满 1 分钟时后台可能自动切到精读。纯函数，内容脚本只喂采样。
// 两次采样都在播时累加中间的真实经过时间，单次最多 1.5 秒；暂停不清零，倍速按真实时间算；
// 播放位置比按倍速推算的多走或少走超过 2 秒算拖动，这一段不计；广告、没画面、在拖动时报不在播。

/** 单次采样最多计这么久：标签页被节流、机器卡住时不一下子记一大段。 */
export const MAX_STEP_SEC = 1.5;

/** 播放位置和推算的差超过这么多算拖动。 */
export const SEEK_TOLERANCE_SEC = 2;

export interface PlaySample {
  /** 采样时的真实时间，毫秒。 */
  readonly at: number;
  /** 这一刻在播：找到主视频、不是广告、没暂停、没在拖动、有画面。 */
  readonly playing: boolean;
  /** 播放位置，秒。 */
  readonly position: number;
  /** 倍速。 */
  readonly rate: number;
}

export interface PlayClock {
  /** 喂一次采样，回累计的秒数。 */
  sample(sample: PlaySample): number;
  readonly playedSec: () => number;
}

/** 从 startSec 接着计：同一标签页刷新同一个视频时，后台回会话里已经累计的秒数。 */
export function createPlayClock(startSec = 0): PlayClock {
  let played = Math.max(0, Number.isFinite(startSec) ? startSec : 0);
  let last: PlaySample | null = null;
  return {
    sample(next) {
      const previous = last;
      last = next;
      if (!previous || !previous.playing || !next.playing) return played;
      const elapsed = (next.at - previous.at) / 1000;
      if (!(elapsed > 0)) return played;
      const rate = Number.isFinite(previous.rate) && previous.rate > 0 ? previous.rate : 1;
      const moved = next.position - previous.position;
      if (!Number.isFinite(moved) || Math.abs(moved - elapsed * rate) > SEEK_TOLERANCE_SEC) return played;
      played += Math.min(elapsed, MAX_STEP_SEC);
      return played;
    },
    playedSec: () => played,
  };
}
