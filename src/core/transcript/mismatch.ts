// 字幕时间轴和视频时长对不上时的判断和提示。
import type { CaptionEntries, MaybeCaptionEntry } from "./segment.ts";

export type TimelineMismatch = "" | "overrun" | "undercoverage";

const MISMATCH_OVERRUN_MIN_SECONDS = 30;
const MISMATCH_OVERRUN_RATIO = 0.1;
const MISMATCH_COVERAGE_MIN_DURATION = 600;
const MISMATCH_COVERAGE_RATIO = 0.3;

/**
 * B 站偶尔把别的视频的字幕挂到当前视频上（AI 字幕尤其多见）。拿视频（当前分 P）的时长和字幕
 * 时间轴比一比，明显对不上时回原因，对得上或没法判断时回空串。只看最晚的结束时间，宁可漏报不误报：
 *  - 开头静音、片头音乐很常见，第一句从哪开始说明不了什么，不看。
 *  - overrun：最后一句结束得比视频晚 max(30 秒, 时长的 10%) 以上。字幕的结束时间常比画面多出
 *    几秒（末句时长按阅读速度补齐），平台给的时长也只精确到秒；30 秒兜住短视频，10% 兜住长视频
 *    重新压制、剪掉片尾这类小出入。
 *  - undercoverage：10 分钟及以上的视频，最后一句结束在前 30% 以内。片尾音乐、彩蛋、无人声的
 *    游戏或演奏段落通常只占结尾一小段，留到七成空白已经远超这些情况；不到 10 分钟的视频后半段
 *    纯画面很常见，不看比例。
 * durationSeconds 必须是当前分 P 的时长，拿全片总时长会把后面几 P 误判成只覆盖开头。
 * 时长拿不到（0、缺失）或字幕时间戳全是 0 时不判断。
 */
export function subtitleTimelineMismatch(entries: CaptionEntries, durationSeconds: unknown): TimelineMismatch {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return "";
  const list: readonly MaybeCaptionEntry[] = Array.isArray(entries) ? entries : [];
  let lastEnd = 0;
  for (const entry of list) {
    const start = Number(entry?.start);
    if (!Number.isFinite(start)) continue;
    const length = Number(entry?.duration);
    lastEnd = Math.max(lastEnd, start + (Number.isFinite(length) && length > 0 ? length : 0));
  }
  if (lastEnd <= 0) return "";
  const tolerance = Math.max(MISMATCH_OVERRUN_MIN_SECONDS, duration * MISMATCH_OVERRUN_RATIO);
  if (lastEnd > duration + tolerance) return "overrun";
  if (duration >= MISMATCH_COVERAGE_MIN_DURATION && lastEnd < duration * MISMATCH_COVERAGE_RATIO) {
    return "undercoverage";
  }
  return "";
}

// 侧边栏在视频信息下面摆的那行提示。点刷新会跳过缓存和内存里记着的那份，重新读取。
export const SUBTITLE_MISMATCH_NOTICE =
  "这份字幕的时间轴和视频时长对不上，可能不属于本视频。可以点右上角的刷新按钮重新获取。";

// 强制刷新取回的字幕对不上、缓存里原来那份对得上时，继续用原来那份，界面摆这句提示。
export const REFRESH_MISMATCH_NOTICE =
  "刚才重新取到的字幕时间轴和视频时长对不上，可能不属于本视频，这里继续用原来的字幕。";
