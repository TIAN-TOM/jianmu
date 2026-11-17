// 截视频当前的一帧：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 模块顶层只放字面量和函数：函数调用、属性读取、带插值的模板串打包时都算可能有副作用，会把这个模块留在发行包里。
// 只截主视频元素本身，不截整页；截下来的画面只交给这一次调用，不落盘。
// 拒绝分开报：视频已换、找不到视频、正在播广告、受保护（加密播放，或者认不出是不是加密播放）、画面没加载好、
// 不在前台、画布被污染。加密播放在截取前就认出来，不靠截出来是不是黑帧判断。
import type { VideoKey } from "../core/video-ref.ts";
import type { ContentReply, FrameRefusal } from "../shared/messages/content.ts";
import type { MainVideo } from "../sites/page-types.ts";

/** 长边上限和 JPEG 质量的初值，第 11 步按实际编码结果的读字情况定。 */
export const FRAME_MAX_EDGE = 1456;
export const FRAME_JPEG_QUALITY = 0.85;
/** 请求里长边的取值范围。 */
export const FRAME_EDGE_MIN = 16;
export const FRAME_EDGE_MAX = 4096;
/** 播放中等下一帧最多这么久。 */
export const NEXT_FRAME_TIMEOUT_MS = 1000;
export const JPEG_DATA_URL_PREFIX = "data:image/jpeg;base64,";

// 媒体元素至少有当前这一帧的数据。
const HAVE_CURRENT_DATA = 2;

export type FrameReply = ContentReply<"player.captureFrame">;

export interface FrameRequest {
  readonly video: VideoKey;
  readonly maxEdge: number;
}

/** 截帧要看的页面状态，和播放器指令共用视频身份的核对。 */
export interface FrameIdentity {
  readonly currentKey: () => VideoKey | null;
  /** 播放器确实在放当前地址上的视频。 */
  readonly confirmed: () => boolean;
  readonly findMainVideo: () => MainVideo;
}

/** 碰浏览器的那几样，测试换替身。 */
export interface FrameEnv extends FrameIdentity {
  /** 标签页在不在前台。 */
  readonly foreground: () => boolean;
  /** 等这个视频画出下一帧，回那一帧的媒体时间；等不到回 null。 */
  readonly nextFrame: (video: HTMLVideoElement, timeoutMs: number) => Promise<number | null>;
  /** 按尺寸画下来编成 JPEG 的 data URL。画布被污染时抛名为 SecurityError 的错。 */
  readonly encode: (video: HTMLVideoElement, width: number, height: number, quality: number) => Promise<string>;
  /** 这个视频元素报过加密媒体的事件。 */
  readonly sawEncrypted: (video: HTMLVideoElement) => boolean;
}

export interface FrameTool {
  /** 认得的截帧指令回结果，认不出的回 null。 */
  readonly handle: (message: unknown) => Promise<FrameReply> | null;
  /** 截当前地址上的视频，给播放页上的图标用。 */
  readonly capture: (maxEdge?: number) => Promise<FrameReply>;
  readonly stop: () => void;
}

type Protection = "clear" | "protected" | "unknown";

/** 视频元素挂没挂加密媒体的钥匙；接口不在时认不出。 */
export function protectionOf(video: HTMLVideoElement): Protection {
  if (!("mediaKeys" in video)) return "unknown";
  const keys: unknown = video.mediaKeys;
  if (keys === null) return "clear";
  return keys === undefined ? "unknown" : "protected";
}

/** 按长边上限等比缩小，不放大；宽高至少 1。 */
export function scaledSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** 只收形状对的截帧指令。 */
export function frameRequestOf(message: unknown): FrameRequest | null {
  if (!isRecord(message) || message.type !== "player.captureFrame" || !isRecord(message.req)) return null;
  const { video, maxEdge } = message.req;
  if (typeof video !== "string" || typeof maxEdge !== "number" || !Number.isInteger(maxEdge)) return null;
  if (maxEdge < FRAME_EDGE_MIN || maxEdge > FRAME_EDGE_MAX) return null;
  return { video: video as VideoKey, maxEdge };
}

const refuse = (code: FrameRefusal): FrameReply => ({ ok: false, code });

const isSecurityError = (error: unknown): boolean => isRecord(error) && error.name === "SecurityError";

export function createFrameCapture(env: FrameEnv): (request: FrameRequest) => Promise<FrameReply> {
  const sameVideo = (request: FrameRequest): boolean => request.video === env.currentKey() && env.confirmed();

  // 截取前和等完下一帧以后各查一遍。
  function check(request: FrameRequest, expected: HTMLVideoElement | null): FrameRefusal | HTMLVideoElement {
    if (!sameVideo(request)) return "VIDEO_CHANGED";
    const main = env.findMainVideo();
    if (main.status === "ad") return "AD_PLAYING";
    if (main.status === "none") return expected ? "VIDEO_CHANGED" : "NO_VIDEO";
    const video = main.video;
    if (expected && video !== expected) return "VIDEO_CHANGED";
    if (protectionOf(video) !== "clear" || env.sawEncrypted(video)) return "PROTECTED";
    if (video.readyState < HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return "FRAME_NOT_READY";
    if (!env.foreground()) return "NOT_FOREGROUND";
    return video;
  }

  return async (request) => {
    const first = check(request, null);
    if (typeof first === "string") return refuse(first);
    let atSec = Number(first.currentTime) || 0;
    // 播放中拿到的是正在换的画面，等下一帧画好再截。
    if (!first.paused && !first.ended) {
      const mediaTime = await env.nextFrame(first, NEXT_FRAME_TIMEOUT_MS);
      if (mediaTime === null) return refuse("FRAME_NOT_READY");
      atSec = mediaTime;
    }
    const video = check(request, first);
    if (typeof video === "string") return refuse(video);
    const size = scaledSize(video.videoWidth, video.videoHeight, request.maxEdge);
    let dataUrl: string;
    try {
      dataUrl = await env.encode(video, size.width, size.height, FRAME_JPEG_QUALITY);
    } catch (error) {
      return refuse(isSecurityError(error) ? "CANVAS_TAINTED" : "FRAME_NOT_READY");
    }
    if (!dataUrl.startsWith(JPEG_DATA_URL_PREFIX) || dataUrl.length === JPEG_DATA_URL_PREFIX.length) return refuse("FRAME_NOT_READY");
    // 编码要一会儿，回之前再认一次视频。
    if (!sameVideo(request)) return refuse("VIDEO_CHANGED");
    return { ok: true, value: { dataUrl, width: size.width, height: size.height, atSec, video: request.video } };
  };
}

/** 截帧工具：播放器指令和播放页图标共用一套核对。 */
export function createFrameTool(env: FrameEnv, stop: () => void = () => undefined): FrameTool {
  const capture = createFrameCapture(env);
  return {
    handle(message) {
      const request = frameRequestOf(message);
      return request ? capture(request) : null;
    },
    capture(maxEdge = FRAME_MAX_EDGE) {
      const video = env.currentKey();
      return video ? capture({ video, maxEdge }) : Promise.resolve(refuse("VIDEO_CHANGED"));
    },
    stop,
  };
}

async function dataUrlOf(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

/** 浏览器里的截帧环境。加密媒体的事件不冒泡，在捕获阶段听整个文档。 */
export function createBrowserFrameTool(document: Document, identity: FrameIdentity): FrameTool {
  const encrypted = new WeakSet<EventTarget>();
  const onEncrypted = (event: Event): void => {
    if (event.target) encrypted.add(event.target);
  };
  document.addEventListener("encrypted", onEncrypted, true);
  const env: FrameEnv = {
    ...identity,
    foreground: () => document.visibilityState === "visible",
    sawEncrypted: (video) => encrypted.has(video),
    nextFrame(video, timeoutMs) {
      if (typeof video.requestVideoFrameCallback !== "function") return Promise.resolve(null);
      return new Promise((resolve) => {
        const handle = video.requestVideoFrameCallback((_now, metadata) => {
          clearTimeout(timer);
          resolve(metadata.mediaTime);
        });
        const timer = setTimeout(() => {
          video.cancelVideoFrameCallback(handle);
          resolve(null);
        }, timeoutMs);
      });
    },
    async encode(video, width, height, quality) {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("没有画布");
      context.drawImage(video, 0, 0, width, height);
      return dataUrlOf(await canvas.convertToBlob({ type: "image/jpeg", quality }));
    },
  };
  return createFrameTool(env, () => document.removeEventListener("encrypted", onEncrypted, true));
}
