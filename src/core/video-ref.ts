// 统一视频身份：所有存储键、任务键、内存键都从这里取，键的写法只在这一处定义。
export type Platform = "bilibili" | "youtube";

export interface VideoRef {
  readonly platform: Platform;
  readonly videoId: string;
  readonly segment?: number; // 只有 B 站分 P 用，第 1 P 也写进键
}

export interface ChannelRef {
  readonly platform: Platform;
  readonly channelId: string;
}

export type VideoKey = string & { readonly __brand: "VideoKey" };

const BILIBILI_ID = /^BV[0-9A-Za-z]{10}$/;
// 编号来自用户正在看的页面，只校验字符集和长度上限，不写死位数。
const YOUTUBE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isSegment(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

export function videoKey(ref: VideoRef): VideoKey {
  if (ref.platform === "bilibili") {
    const segment = ref.segment ?? 1;
    if (!BILIBILI_ID.test(ref.videoId) || !isSegment(segment)) {
      throw new RangeError(`不是有效的 B 站视频身份：${ref.videoId} 第 ${segment} P`);
    }
    return `bilibili:${ref.videoId}:p${segment}` as VideoKey;
  }
  if (!YOUTUBE_ID.test(ref.videoId) || ref.segment !== undefined) {
    throw new RangeError(`不是有效的 YouTube 视频身份：${ref.videoId}`);
  }
  return `youtube:${ref.videoId}` as VideoKey;
}

export function parseVideoKey(key: string): VideoRef | null {
  const bilibili = /^bilibili:([^:]+):p([1-9][0-9]*)$/.exec(key);
  if (bilibili) {
    const [, videoId = "", segmentText = ""] = bilibili;
    const segment = Number(segmentText);
    if (!BILIBILI_ID.test(videoId) || !isSegment(segment)) return null;
    return { platform: "bilibili", videoId, segment };
  }
  const youtube = /^youtube:(.+)$/.exec(key);
  if (youtube) {
    const [, videoId = ""] = youtube;
    return YOUTUBE_ID.test(videoId) ? { platform: "youtube", videoId } : null;
  }
  return null;
}

export function channelKey(ref: ChannelRef): string {
  if (ref.channelId === "") throw new RangeError("频道编号不能为空");
  return `${ref.platform}:${ref.channelId}`;
}
