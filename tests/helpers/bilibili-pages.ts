// 视频网站播放页地址的样例，给按真实地址规则认视频的测试用：普通播放页、合集播放页、老的数字编号地址。编号全部自造。
import { avToBv } from "../../src/sites/bilibili/url.ts";

const ORIGIN = "https://www.bilibili.com";

/** 自造的老数字编号。 */
export const SAMPLE_AID = 987_654_321;

export const videoPageUrl = (videoId: string, segment?: number): string => `${ORIGIN}/video/${videoId}${segment ? `?p=${segment}` : ""}`;

/** 合集播放页：视频编号写在地址的参数里。 */
export const listPageUrl = (videoId: string): string => `${ORIGIN}/list/ml1?bvid=${videoId}`;

/** 老的数字编号地址。 */
export const avPageUrl = (aid: number = SAMPLE_AID): string => `${ORIGIN}/video/av${aid}`;

/** 老的数字编号对应的视频编号。 */
export function avVideoId(aid: number = SAMPLE_AID): string {
  const videoId = avToBv(aid);
  if (!videoId) throw new Error("不是有效的数字编号");
  return videoId;
}
