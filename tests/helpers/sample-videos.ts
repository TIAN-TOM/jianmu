// 测试共用的样例视频：编号是自造的，不对应任何真实视频。
import { videoKey } from "../../src/core/video-ref.ts";

/** 假站点服务和 B 站读取测试用的样例视频号。 */
export const SAMPLE_ID = "BV1Sample000";
/** chrome.* 替身里观看页默认打开的视频号。 */
export const SAMPLE_VIDEO_ID = "BV1Sample001";

/** 两个样例视频号第 1 P 的视频键。 */
export const SAMPLE_KEY = videoKey({ platform: "bilibili", videoId: SAMPLE_ID });
export const SAMPLE_VIDEO_KEY = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID });
